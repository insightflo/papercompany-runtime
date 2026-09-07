// server/src/services/workflow/workflow-child-dispatch.ts
//
// [purpose] workflow→workflow 자식 스텝 dispatch 본체(0101, fix round 4 + cycle A §6/§10).
//   사전검사(precheck) → (레거시 claimed+자식 판별자 수리) → 클레임 트랜잭션
//   (workflow-child-invocation-claim.ts) → 커밋 승자는 adoption 기록 후 실행 진입
//   (executeWorkflowRunWithStartOutcome — 임대 소유자만 초기화)에 도달한다. 재사용/경합/자격
//   탈락은 모두 클레임 트랜잭션 안에서 판정된다 — 잠금 밖 빠른 재사응 권위는 없다(cycle A §6).
//   재사용의 wait 모드는 invocation 의 내구 값이 권위다(fix4 §6 — 정의 변경을 소급하지 않는다).
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { executeWorkflowRunWithStartOutcome } from "./dag-engine.js";
import type { WorkflowStep } from "./dag-engine.js";
import { precheckWorkflowChildDispatch } from "./workflow-child-dispatch-precheck.js";
import { WORKFLOW_CHILD_MAX_CONCURRENT_WAITING } from "./workflow-child-guards.js";
import { failChildStep } from "./workflow-child-completion.js";
import {
  adoptChildForWaitingStep,
  logWorkflowChildRunCreatedActivity,
} from "./workflow-child-execution.js";
import { claimChildInvocation } from "./workflow-child-invocation-claim.js";
import { repairLegacyChildLink } from "./workflow-child-legacy-link.js";
import { isChildStartContention } from "./workflow-child-start-contention.js";

export type WorkflowChildDispatchInput = {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
  /** [cycle B F2] DAG workflow-child 호출부만 채우는 네이티브 retry admission 힌트. */
  nativeRetryAdmission?: {
    retryNumber: number;
    retryCount: number;
    metadata: Record<string, unknown>;
  };
};

/** [cycle A §7] dispatch 결과 — progressed 만 이 호출의 소유 진행이다. waiting 은 재사용(내구
 *  대기 유지), skipped 는 소유자/정산 경로 양보, failed 는 스텝이 fenced 실패로 마감됐음을 뜻한다. */
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
      await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: step.id,
        errorCode: precheck.errorCode,
        detail: precheck.detail,
      });
      return { outcome: "failed" };
    }
    const { target, renderedInputs } = precheck;
    const incomingWait = (step as { wait?: unknown }).wait !== false;
    const expectedGeneration = (stepRun.retryCount ?? 0) + 1;

    // [cycle A §10] 레거시 coherent claimed+자식 영수증의 재사용 — 클레임 트랜잭션은 linked 만
    //   재사용하므로, 동일 세대 claimed+nonnull 을 먼저 경비 수리하고 진행한다. 수리 실패는 양보.
    const [existingInvocation] = await db
      .select()
      .from(workflowStepInvocations)
      .where(eq(workflowStepInvocations.parentStepRunId, stepRun.id))
      .limit(1);
    if (
      existingInvocation
      && existingInvocation.generation === expectedGeneration
      && existingInvocation.state === "claimed"
      && existingInvocation.childRunId !== null
    ) {
      const repaired = await repairLegacyChildLink(db, {
        companyId,
        parentRunId: run.id,
        parentStepRunId: stepRun.id,
        invocationId: existingInvocation.id,
        generation: existingInvocation.generation,
        childRunId: existingInvocation.childRunId,
      });
      if (repaired === "ineligible" || repaired === "busy") return { outcome: "skipped" };
    }

    // 원자적 클레임: 잠금 하 세대 유도/검증 + invocation 판정 + 자식 run 행 생성 + 링크 커밋.
    // [cycle B F2 수정] nativeRetryAdmission 힌트를 클레임까지 전달한다 — 이전 구현은 여기서 힌트를
    //   유실해 due waiting retry 의 네이티브 해제가 항상 ineligible 로 탈락했다(설계 §2 위반).
    const claim = await claimChildInvocation(db, {
      companyId,
      run,
      parentStepRunId: stepRun.id,
      incomingWait,
      generation: expectedGeneration,
      targetWorkflowId: target.id,
      renderedInputs,
      now,
      ...(input.nativeRetryAdmission ? { nativeRetryAdmission: input.nativeRetryAdmission } : {}),
    });

    if (claim.outcome === "parent-cancelled") {
      await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: step.id,
        errorCode: "child_run_cancelled",
        detail: "parent workflow run was cancelled before child dispatch",
      });
      return { outcome: "failed" };
    }
    if (claim.outcome === "cap-exceeded") {
      await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: step.id,
        errorCode: "child_concurrency_exceeded",
        detail: `parent run already has ${WORKFLOW_CHILD_MAX_CONCURRENT_WAITING} committed waiting children (cap ${WORKFLOW_CHILD_MAX_CONCURRENT_WAITING})`,
      });
      return { outcome: "failed" };
    }
    if (claim.outcome === "tombstone") {
      // [fix3 P1-4] 회복과 동일한 tombstone 정산 — 자식을 재생성하지 않고 fenced 실패로 마감.
      await failChildStep(db, {
        companyId,
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        stepId: step.id,
        errorCode: "child_run_failed",
        detail: "linked child workflow run was deleted",
        fence: { invocationId: claim.invocationId, generation: claim.generation, childDeleted: true },
      });
      return { outcome: "failed" };
    }
    if (claim.outcome === "ineligible" || claim.outcome === "busy") {
      // [cycle A §6/§8] 스테일 세대/자격 상실/경합 — 부작용 없이 소유자에게 양보한다.
      return { outcome: "skipped" };
    }

    if (claim.outcome === "reused") {
      // [cycle A §6] 재사용도 adoption 을 현재 fence 로 수리한다(커밋된 wait/신원 사용 — 세대
      //   재구성 없음). 실행 재진입은 없다 — 내구 대기는 그대로 유지된다.
      await adoptChildForWaitingStep(db, {
        companyId, run, step, stepRun, now,
        wait: claim.wait,
        renderedInputs,
        invocationId: claim.invocationId,
        childRunId: claim.childRunId,
        generation: claim.generation,
      });
      return { outcome: "waiting" };
    }

    // claim.outcome === "created" — adoption 을 실행 "전에" 기록한다(종말 훅 fence 요구).
    const adopted = await adoptChildForWaitingStep(db, {
      companyId, run, step, stepRun, now, wait: claim.wait, renderedInputs,
      invocationId: claim.invocationId,
      childRunId: claim.childRunId,
      generation: claim.generation,
    });
    if (!adopted) {
      // 최신 세대 adoption 이 경합에서 이겼다 — 소유자가 계속 진행한다(스텝 실패 아님).
      return { outcome: "skipped" };
    }
    await logWorkflowChildRunCreatedActivity(db, {
      companyId,
      childRunId: claim.childRunId,
      parentRunId: run.id,
      parentStepRunId: stepRun.id,
      targetWorkflowId: target.id,
    });

    // 실행 진입 — 임대 소유자만 초기화한다(creator race/duplicate steps 차단).
    // readiness 실패는 run-start 내부에서 fenced 소유자 실패 정산 후 원본 오류를 재던진다 —
    // 이 호출의 소유 진행으로 보고한다(정산은 이미 커밋됐다).
    // [cycle B §7] 타입핑 결과로만 판단한다 — started=시작/sync 진입, settled=이 호출의 마감 정산,
    //   materialized=기존 초기화된 자식(새 시작 아님→waiting), busy/ineligible/expired=양보(skipped).
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
    // [cycle A §8] 경합은 실패 정산 없이 양보한다. 그 외 실행 진입 예외는 이미 소유 fence 정산
    // (run-start preparation scope)되었거나 회복 경로의 소관이다 — failed 로 보고하고 원본을
    // 실행 경계로 전파하지 않는다(공개 boolean 래퍼는 false).
    if (isChildStartContention(error)) return { outcome: "skipped" };
    return { outcome: "failed" };
  }
}

/**
 * type:"workflow" 스텝 dispatch. true = dispatched/waiting/양보(기존 자식 포함), false = step 실패로
 * 마감. 공개 래퍼 — failed 만 false 다(cycle A §6/§8).
 */
export async function dispatchWorkflowChildStep(input: WorkflowChildDispatchInput): Promise<boolean> {
  const { db, ...rest } = input;
  const outcome = await dispatchWorkflowChildStepWithOutcome(db, rest);
  return outcome.outcome !== "failed";
}
