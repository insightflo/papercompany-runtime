// server/src/services/workflow/workflow-child-execution.ts
//
// [purpose] descope v1 — workflow→workflow 자식 스텝 adoption(표시 프로젝션 전용) + 공용
//   re-export. adoption 은 실행 권위가 아니다: 완료 판정은 completion 경로의 최종 쓰기가 자식의
//   내구 상태를 직접 읽는다. 자식 run "행" 생성은 클레임 트랜잭션의 CREATE 형
//   (workflow-child-create-forms) 전용이고, 실행 진입은 전체 신원 임대 취득
//   (workflow-child-start-lease)의 소유자만 한다 — unleased 시작 헬퍼/즉시 완료(fire)는
//   삭제됐다(D1/D3/D5).
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import {
  autoPredicate,
  type ChildStartTables,
  type WorkflowChildIdentity,
} from "./workflow-child-start-predicates.js";

export {
  assertNoWorkflowChildDefinitionCycles,
  assertWorkflowChildDefinitionCycles,
  isWorkflowChildStep,
  WORKFLOW_CHILD_MAX_CONCURRENT_WAITING,
  WORKFLOW_CHILD_MAX_DEPTH,
  WORKFLOW_CHILD_RECONCILE_MIN_AGE_MS,
} from "./workflow-child-guards.js";
export {
  dispatchWorkflowChildStep,
  dispatchWorkflowChildStepWithOutcome,
  type WorkflowChildDispatchInput,
  type WorkflowChildDispatchOutcome,
} from "./workflow-child-dispatch.js";
export {
  runWorkflowChildCompletionHook,
  type WorkflowChildTerminalRun,
} from "./workflow-child-completion.js";
export {
  hasLiveWorkflowChildWait,
  reconcileWorkflowChildStepWaits,
  type WorkflowChildReconciliationResult,
} from "./workflow-child-reconciler.js";

const ADOPTION_TABLES: ChildStartTables = {
  parent: alias(workflowRuns, "wce_parent") as unknown as typeof workflowRuns,
  invocation: workflowStepInvocations,
  parentStep: workflowStepRuns,
  child: alias(workflowRuns, "wce_child") as unknown as typeof workflowRuns,
};

/**
 * adoption — 자식 링크의 표시 프로젝션 기록(projection-only). AUTO 술어(BASE_ID + CURRENT +
 * running 부모 + pending 스텝)를 갱신 문장 자체에서 재평가하고, 관측 메타데이터 스냅숏 일치
 * (IS NOT DISTINCT FROM, null-safe)로 동시 경합을 원자 차단한다. 무관한 메타데이터 키는
 * 보존된다. 0행(스테일 관측/경합)은 조용한 양보 — 스텝 실패가 아니다. 완료 즉시 처리(fire)는
 * 존재하지 않는다(D1): 부모 스텝은 자신의 bound 자식이 종말이 될 때까지 pending 으로 남는다.
 */
export async function adoptChildForWaitingStep(
  db: Db,
  input: {
    identity: WorkflowChildIdentity;
    observedMetadata: unknown;
    now: Date;
  },
): Promise<boolean> {
  const { identity, now } = input;
  const previousMetadata = input.observedMetadata !== null
    && typeof input.observedMetadata === "object"
    && !Array.isArray(input.observedMetadata)
    ? input.observedMetadata as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = {
    ...previousMetadata,
    // 표시 프로젝션 — 실행 권위 아님(완료는 invocation/자식 내구 행이 권위).
    workflowChild: {
      childRunId: identity.childRunId,
      invocationId: identity.invocationId,
      generation: identity.generation,
      dispatchedAt: now.toISOString(),
    },
  };
  const t = ADOPTION_TABLES;
  const b = identity;
  const adopted = await db
    .update(workflowStepRuns)
    .set({ lastDispatchAttemptAt: now, metadata })
    .where(and(
      eq(workflowStepRuns.id, b.parentStepRunId),
      // AUTO + outer S.id 상관 + 모든 B ID + bound C 법정 상태(pending/running)를 한 문장에서.
      sql`exists (select 1
        from workflow_runs ${t.parent}, workflow_step_invocations ${t.invocation}, workflow_step_runs ${t.parentStep}, workflow_runs ${t.child}
        where ${autoPredicate(t, b)}
          and ${t.parentStep}.id = workflow_step_runs.id
          and ${t.child}.status in ('pending', 'running'))`,
      // null-safe 관측 메타데이터 동등성 — 무관한 키의 무해 드리프트는 0행(양보, 새 관측 재시도 가능).
      sql`${workflowStepRuns.metadata} is not distinct from ${JSON.stringify(previousMetadata)}::jsonb`,
    ))
    .returning({ id: workflowStepRuns.id });
  return adopted.length > 0;
}

export async function logWorkflowChildRunCreatedActivity(
  db: Db,
  input: {
    companyId: string;
    childRunId: string;
    parentRunId: string;
    parentStepRunId: string;
    targetWorkflowId: string;
  },
): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workflow-step",
    action: "workflow_run.created",
    entityType: "workflow_run",
    entityId: input.childRunId,
    details: {
      triggerSource: "workflow",
      triggeredBy: "workflow-step",
      parentRunId: input.parentRunId,
      parentStepRunId: input.parentStepRunId,
      targetWorkflowId: input.targetWorkflowId,
    },
  });
}
