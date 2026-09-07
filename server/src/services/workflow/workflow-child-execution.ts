// server/src/services/workflow/workflow-child-execution.ts
//
// [purpose] workflow→workflow 자식 스텝 adoption + 공용 re-export(0101, fix round).
//   adoption: 세대 CAS fence 가 걸린 waiting 메타데이터 기록(wait:true 는 pending 유지,
//   마감은 completion hook) / wait:false 는 fire-and-forget 즉시 완료. 자식 run "행" 생성은
//   dispatch 의 클레임 트랜잭션 내부(createChildWorkflowRunRowInTx)에서 이뤄지고, 실행
//   (executeWorkflowRun)은 커밋 후 승자만 수행한다 — 이중 실행/고아 자식 원천 차단.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { completeWorkflowToolStepFromResult } from "./dag-engine.js";
import type { WorkflowStep } from "./dag-engine.js";

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

export type ChildCompletionFence = {
  invocationId: string;
  childRunId: string;
  generation: number;
};

export async function adoptChildForWaitingStep(
  db: Db,
  input: {
    companyId: string;
    run: typeof workflowRuns.$inferSelect;
    step: WorkflowStep;
    stepRun: typeof workflowStepRuns.$inferSelect;
    now: Date;
    wait: boolean;
    renderedInputs: Record<string, string>;
    invocationId: string;
    childRunId: string;
    generation: number;
  },
): Promise<boolean> {
  const { run, step, stepRun, now, wait } = input;
  const stepRunRow = (await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, stepRun.id))
    .limit(1))[0];
  if (!stepRunRow) return false;

  const previousMetadata = stepRunRow.metadata && typeof stepRunRow.metadata === "object" && !Array.isArray(stepRunRow.metadata)
    ? stepRunRow.metadata as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = {
    ...previousMetadata,
    workflowChild: {
      childRunId: input.childRunId,
      invocationId: input.invocationId,
      generation: input.generation,
      wait,
      dispatchedAt: now.toISOString(),
    },
  };
  // [cycle B F2] adoption 은 retry 상태를 전이시키지 않는다 — waiting→dispatching 해제는
  //   claim 트랜잭션의 원자적 native admission 전용이다. 기존 workflowRetry(dispatching)는
  //   previousMetadata spread 로 보존되며, 신규 클레임 시 admission 이 선(先)기록한다.
  delete metadata.workflowRetryExhaustion;
  // [cycle B F2] adoption 은 retry 를 해제(release)하지 않는다 — 대기→진행 전이는 네이티브
  //   릴리즈(claim 의 원자적 admission) 전용이다. fence: 현재 세대(CURRENT) + retry 미대기
  //   (NOT_WAITING) + linked 동일 회사/부모 신원 + 관측 메타데이터 스냅숏 일치(CAS — 동시
  //   retry 스케줄/입양 경합을 원자 차단; 첫 adoption 의 메타데이터 부재도 자연 처리).
  //   실행 권위는 workflowChild 텍스트가 아니라 invocation 의 내구 세대다.
  const adopted = await db
    .update(workflowStepRuns)
    .set({ lastDispatchAttemptAt: now, metadata })
    .where(and(
      eq(workflowStepRuns.id, stepRun.id),
      eq(workflowStepRuns.status, "pending"),
      sql`${workflowStepRuns.retryCount} + 1 = ${input.generation}`,
      sql`coalesce(${workflowStepRuns.metadata}->'workflowRetry'->>'state', '') <> 'waiting'`,
      eq(workflowStepRuns.metadata, stepRunRow.metadata),
      sql`exists (select 1 from workflow_step_invocations i
        where i.id = ${input.invocationId}::uuid and i.generation = ${input.generation}
          and i.child_run_id = ${input.childRunId}::uuid and i.state = 'linked'
          and i.company_id = (select c.company_id from workflow_runs c where c.id = ${input.childRunId}::uuid))`,
    ))
    .returning({ id: workflowStepRuns.id });

  if (adopted.length === 0) {
    // 최신 세대 adoption 이 이미 기록했거나(경합), 스테일 스냅숏이 새 retry 를 소비하려 한 경우 —
   // 조용히 포기한다(스텝 실패 아님; 소유자가 계속 진행).
    return false;
  }

  if (!wait) {
    // fire-and-forget: 스텝을 즉시 succeeded 로 마감하고 childRunId 를 결과 metadata 에 남긴다.
    await completeWorkflowToolStepFromResult(db, {
      companyId: run.companyId,
      stepRunId: stepRun.id,
      workflowRunId: run.id,
      stepId: step.id,
      toolName: "workflow",
      success: true,
      data: { ok: true, childRunId: input.childRunId, wait: false, inputs: input.renderedInputs },
      stdout: "",
      exitCode: 0,
    });
  }
  return true;
}

/**
 * [fix2 P1-2] 원자적 시작 클레임 — pending 자식 run 을 running 으로 전환하는 유일한 시작 진입.
 *   생성자(dispatch 승자)와 회복자(reconciler)가 모두 이 CAS로 시작 소유권을 얻고,
 *   승자만 executeWorkflowRun 을 호출한다. 취소/종말/이미 시작된 자식은 0행(패자) —
 *   취소된 자식이 지연 실행으로 되살아나는 일은 없다.
 */
export async function claimWorkflowChildRunStart(
  db: Db,
  input: { childRunId: string; companyId: string },
): Promise<boolean> {
  // startedAt 는 JS ms 정밀도로 기록한다 — 회복 임대 재획득(lease CAS)이 동일 값 비교로
  // 승자를 가리기 때문에 PG now() 의 microsecond 정밀도를 쓰면 비교가 항상 실패한다.
  // (sql 템플릿 파라미터는 ISO 문자열로 바인딩한다 — 드라이버 Date 직렬화 불일치 회피.)
  const startedAtIso = new Date().toISOString();
  const claimed = await db
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: sql`coalesce(${workflowRuns.startedAt}, ${startedAtIso}::timestamptz)`,
    })
    .where(and(
      eq(workflowRuns.id, input.childRunId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.status, "pending"),
    ))
    .returning({ id: workflowRuns.id });
  return claimed.length > 0;
}

/**
 * 클레임 트랜잭션 "내부"에서 자식 run 행을 생성한다(실행 없음). missionId 는 의도적으로
 * null — 자식 종말/취소가 부모/형제 미션 런타임을 중단시키지 않는다(fix round P1-6).
 * 부모 연결 컬럼 + metadata.workflowChildInputs 는 관측용으로 유지된다.
 */
export async function createChildWorkflowRunRowInTx(
  tx: Pick<Db, "insert">,
  input: {
    parentRun: typeof workflowRuns.$inferSelect;
    parentStepRunId: string;
    childRunId: string;
    targetWorkflowId: string;
    companyId: string;
    renderedInputs: Record<string, string>;
    now: Date;
  },
): Promise<void> {
  const { parentRun } = input;
  await tx.insert(workflowRuns).values({
    id: input.childRunId,
    workflowId: input.targetWorkflowId,
    companyId: input.companyId,
    missionId: null,
    status: "pending",
    triggeredBy: "workflow-step",
    triggerSource: "workflow",
    parentRunId: parentRun.id,
    parentStepRunId: input.parentStepRunId,
    rootRunId: parentRun.rootRunId ?? parentRun.id,
    metadata: { workflowChildInputs: input.renderedInputs },
    createdAt: input.now,
  });
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
