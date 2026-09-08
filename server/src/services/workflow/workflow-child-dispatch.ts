// server/src/services/workflow/workflow-child-dispatch.ts
//
// [purpose] descope v1 — workflow→workflow 자식 스텝 dispatch 본체. 흐름은 사전검사(precheck,
//   v1 계약 거부 포함) → 클레임 트랜잭션(claimChildInvocation, 세대는 항상 1) → 결과 분기다.
//   레거시 판별자 수리/네이티브 retry admission/incomingWait 는 존재하지 않는다(D1/D2/D5).
//   분기: parent-cancelled/cap-exceeded → pre-admission 형 실패 정산, tombstone → tombstone 형
//   정산, invalid-state → 구조화 감사 이벤트 + skipped(행 무변경), ineligible/busy → skipped,
//   reused/created → adoption(표시 프로젝션 전용, 새 시그니처) 후 created 만 실행 진입.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 파싱 권위 없음).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { executeWorkflowRunWithStartOutcome } from "./dag-engine.js";
import type { WorkflowStep } from "./dag-engine.js";
import { failChildStep } from "./workflow-child-completion.js";
import {
  adoptChildForWaitingStep,
  logWorkflowChildRunCreatedActivity,
} from "./workflow-child-execution.js";
import { WORKFLOW_CHILD_MAX_CONCURRENT_WAITING } from "./workflow-child-guards.js";
import { claimChildInvocation } from "./workflow-child-invocation-claim.js";
import { precheckWorkflowChildDispatch } from "./workflow-child-dispatch-precheck.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";
import type { WorkflowChildIdentity } from "./workflow-child-start-predicates.js";

export type WorkflowChildDispatchInput = {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
};

/** dispatch 결과 — progressed 만 이 호출의 소유 진행이다. waiting 은 내구 대기 유지, skipped 는
 *  소유자/정산/무효 상태 양보, failed 는 스텝이 fenced 실패로 마감됐음을 뜻한다. */
export type WorkflowChildDispatchOutcome = {
  outcome: "progressed" | "waiting" | "skipped" | "failed";
};

/** 타입핑 dispatch — 회복(reconciler)과 내부 호출이 소유 결과를 구분할 때 사용한다. */
export async function dispatchWorkflowChildStepWithOutcome(
  db: Db,
  input: Omit<WorkflowChildDispatchInput, "db">,
): Promise<WorkflowChildDispatchOutcome> {
  const { run, definition, step, stepRun, now } = input;
  const companyId = run.companyId;
  try {
    const precheck = await precheckWorkflowChildDispatch(db, { run, definition, step });
    if (!precheck.ok) {
      // 클레임 이전 실패 — invocation 부재 조건이 있는 pre-admission 형으로 정산한다.
      const settled = await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: stepRun.stepId,
        errorCode: precheck.errorCode,
        detail: precheck.detail,
      });
      return settled.outcome === "settled" ? { outcome: "failed" } : { outcome: "skipped" };
    }
    const { target, renderedInputs } = precheck;

    // 원자적 클레임 — 부모/정의 잠금 하 단일 invocation 판정 + 자식 run 행 생성 + 링크 커밋.
    const claim = await claimChildInvocation(db, {
      companyId,
      run,
      parentStepRunId: stepRun.id,
      stepId: stepRun.stepId,
      generation: 1,
      targetWorkflowId: target.id,
      renderedInputs,
      now,
    });

    if (claim.outcome === "parent-cancelled") {
      const settled = await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: stepRun.stepId,
        errorCode: "child_run_cancelled",
        detail: "parent workflow run was cancelled before child dispatch",
      });
      return settled.outcome === "settled" ? { outcome: "failed" } : { outcome: "skipped" };
    }
    if (claim.outcome === "cap-exceeded") {
      const settled = await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: stepRun.stepId,
        errorCode: "child_concurrency_exceeded",
        detail: `parent run already has ${WORKFLOW_CHILD_MAX_CONCURRENT_WAITING} committed waiting children (cap ${WORKFLOW_CHILD_MAX_CONCURRENT_WAITING})`,
      });
      return settled.outcome === "settled" ? { outcome: "failed" } : { outcome: "skipped" };
    }
    if (claim.outcome === "tombstone") {
      // [D4] 삭제 tombstone — 자식을 재생성하지 않고 tombstone 형으로 1회 fenced 정산.
      const settled = await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: stepRun.stepId,
        errorCode: "child_run_failed",
        detail: "linked child workflow run was deleted",
        tombstone: { invocationId: claim.invocationId, generation: claim.generation },
      });
      return settled.outcome === "settled" ? { outcome: "failed" } : { outcome: "skipped" };
    }
    if (claim.outcome === "invalid-state") {
      // 설계 §2 표 밖 상태 — 구조화 감사 이벤트만 남기고 실행 행은 무변경(fail-closed).
      await logInvalidStateAudit(db, {
        companyId,
        stepRunId: stepRun.id,
        parentRunId: run.id,
        reason: claim.reason,
      });
      return { outcome: "skipped" };
    }
    if (claim.outcome === "ineligible" || claim.outcome === "busy") {
      // 자격 상실/경합 — 부작용 없이 소유자에게 양보한다.
      return { outcome: "skipped" };
    }

    // reused/created — adoption(표시 프로젝션 전용)을 새 시그니처로 기록한다.
    const identity: WorkflowChildIdentity = {
      companyId,
      parentRunId: run.id,
      parentStepRunId: stepRun.id,
      stepId: stepRun.stepId,
      invocationId: claim.invocationId,
      childRunId: claim.childRunId,
      generation: 1,
    };
    if (claim.outcome === "reused") {
      // 내구 대기는 그대로 유지 — 실행 재진입 없다. adoption 상실(무해 드리프트)도 waiting.
      await adoptWithFreshMetadata(db, identity, now);
      return { outcome: "waiting" };
    }

    // created — adoption 을 실행 "전에" 기록한다. 경합 패자는 양보(스텝 실패 아님).
    const adopted = await adoptWithFreshMetadata(db, identity, now);
    if (!adopted) return { outcome: "skipped" };
    await logWorkflowChildRunCreatedActivity(db, {
      companyId,
      childRunId: claim.childRunId,
      parentRunId: run.id,
      parentStepRunId: stepRun.id,
      targetWorkflowId: target.id,
    });

    // 실행 진입 — 전체 신원 임대(start-lease) 소유자만 초기화한다.
    // [cycle B §7] started/settled=소유 진행, materialized=기존 초기화 자식(waiting),
    //   busy/ineligible/expired=양보(skipped).
    const startOutcome = await executeWorkflowRunWithStartOutcome(db, claim.childRunId);
    switch (startOutcome.kind) {
      case "started":
      case "settled":
        return { outcome: "progressed" };
      case "materialized":
        return { outcome: "waiting" };
      default:
        return { outcome: "skipped" };
    }
  } catch (error) {
    // 경합은 실패 정산 없이 양보한다. [설계 §6 r7] 알 수 없는 오류는 정확한 원본 그대로 호출자에게
    // 전파된다(롤백 후) — 정산 승리 없는 failed 보고/삼키기 금지. 실행 정산은 이미 소유 fence
    // (run-start scope)에서 커밋됐을 수 있고, 그 경우에도 원본 오류가 우선 권위다.
    if (isChildStartContention(error)) return { outcome: "skipped" };
    throw error;
  }
}

/** adoption 직전 step-run metadata 를 재적재해 관측 스냅숏을 신선하게 유지한다(무해 드리프트 최소화). */
async function adoptWithFreshMetadata(
  db: Db,
  identity: WorkflowChildIdentity,
  now: Date,
): Promise<boolean> {
  const [fresh] = await db
    .select({ metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, identity.parentStepRunId))
    .limit(1);
  return await adoptChildForWaitingStep(db, {
    identity,
    observedMetadata: fresh?.metadata ?? null,
    now,
  });
}

/** invalid-state 구조화 감사 이벤트 — 2차 기록 실패는 primary 흐름(행 무변경)을 대체하지 않는다. */
async function logInvalidStateAudit(
  db: Db,
  input: { companyId: string; stepRunId: string; parentRunId: string; reason: string },
): Promise<void> {
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "workflow-step",
      action: "workflow_child_invalid_state",
      entityType: "workflow_step_run",
      entityId: input.stepRunId,
      details: {
        reason: input.reason,
        parentRunId: input.parentRunId,
        disposition: "skipped_rows_unchanged",
      },
    });
  } catch {
    // 감사 기록 실패는 invalid-state 의 fail-closed 결과(행 무변경)를 바꾸지 않는다.
  }
}

/**
 * type:"workflow" 스텝 dispatch. true = dispatched/waiting/양보(기존 자식 포함), false = step 실패로
 * 마감. 공개 래퍼 — failed 만 false 다.
 */
export async function dispatchWorkflowChildStep(input: WorkflowChildDispatchInput): Promise<boolean> {
  const { db, ...rest } = input;
  const outcome = await dispatchWorkflowChildStepWithOutcome(db, rest);
  return outcome.outcome !== "failed";
}
