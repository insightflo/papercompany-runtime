import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { isRunReopenGuardEnabled, isRunRecoveryServiceEnabled, RUN_REOPEN_RESUMABLE_STATUSES } from "./run-reopen-guard-flag.js";
import { latestTerminalDecision, recoverTerminalRun } from "./run-recovery-authority.js";
import type { WorkflowExecutionResult } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export async function retryIssueLessToolWorkflowStepInternal<TStep>(input: {
  db: Db;
  companyId: string;
  runId: string;
  stepId: string;
  /** [run-recovery-service v1] 호출자 멱등 키(감독 재시도 키) — 공식 복구의 1회 소비 판정에 쓴다. */
  recoveryRequestReference?: string | null;
  loadWorkflowExecutionContext: (db: Db, runId: string) => Promise<{
    run: { id: string; companyId: string; startedAt: Date | null; status: string; dispatchAuthorityVersion: number };
    steps: TStep[];
    stepRuns: (typeof workflowStepRuns.$inferSelect)[];
  }>;
  isIssueLessToolStep: (step: TStep) => boolean;
  resetUnlaunchedTerminalStepRuns: (
    db: Db,
    stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  ) => Promise<(typeof workflowStepRuns.$inferSelect)[]>;
  syncWorkflowRunState: (db: Db, runId: string) => Promise<WorkflowExecutionResult>;
}): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  // [run-reopen-guard v1] 플래그는 함수 진입부 1회 읽는다 — off 면 이후 판정/쓰기가 전혀 없다.
  //   [봇 지적 교정] 복구 플래그 판정은 isRunRecoveryServiceEnabled 내부에서 reopenGuard 와
  //   AND 로 통일한다(호출부마다 게이팅이 갈라지는 것을 원천 봉쇄).
  const reopenGuardEnabled = await isRunReopenGuardEnabled(input.db);
  const recoveryServiceEnabled = await isRunRecoveryServiceEnabled(input.db);
  const context = await input.loadWorkflowExecutionContext(input.db, input.runId);
  if (context.run.companyId !== input.companyId) return null;

  const step = context.steps.find((candidate) =>
    typeof candidate === "object"
    && candidate !== null
    && (candidate as { id?: string }).id === input.stepId,
  );
  const stepRun = context.stepRuns.find((candidate) => candidate.stepId === input.stepId);
  if (!step || !stepRun) return null;
  if (!input.isIssueLessToolStep(step) || stepRun.issueId) return null;
  if (stepRun.status !== "failed") return null;

  const observedRequestId = stepRun.lastDispatchRequestId;
  const observedCompletedAt = stepRun.completedAt;

  // [run-recovery-service v1 — PR-2b] 결정이 기록된 failed 종결 run 은 공식 복구(1회 소비·
  // 버전 검증)를 먼저 소비한다 — 어떤 스텝 쓰기보다 앞서므로 거절 시 잔류가 없다. 복구가
  // 이미 run 을 재개+범프했으므로 아래 기존 run CAS 는 건너뛴다(이중 범프 방지).
  let reopenedByRecovery = false;
  if (recoveryServiceEnabled && context.run.status === "failed") {
    const latestDecision = await latestTerminalDecision(input.db, input.runId, input.companyId);
    if (latestDecision && latestDecision.decidedAuthorityVersion === context.run.dispatchAuthorityVersion) {
      const recovery = await recoverTerminalRun(input.db, {
        runId: input.runId,
        companyId: input.companyId,
        expectedAuthorityVersion: context.run.dispatchAuthorityVersion,
        expectedDecision: latestDecision.decision,
        recoveryKind: "supervision_tool_retry",
        requestReference: input.recoveryRequestReference ?? null,
        requestedBy: "mission_supervision",
        now: new Date(),
      });
      if (recovery.kind === "recovered" || recovery.kind === "already_consumed") {
        reopenedByRecovery = true;
      } else {
        // stale_authority/decision_mismatch — 낡은 권한으로는 되살리지 않는다(실패닫힘).
        return null;
      }
    }
  }

  const metadata = record(stepRun.metadata);
  delete metadata.toolResult;
  delete metadata.toolInvocation;
  delete metadata.toolQueue;
  delete metadata.cacheHit;
  delete metadata.controlFlowSkipped;

  const retryCas = await input.db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      lastDispatchRequestId: null,
      lastDispatchAttemptAt: null,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
      metadata,
    })
    .where(and(
      eq(workflowStepRuns.id, stepRun.id),
      eq(workflowStepRuns.status, "failed"),
      ...(observedRequestId
        ? [eq(workflowStepRuns.lastDispatchRequestId, observedRequestId)]
        : [isNull(workflowStepRuns.lastDispatchRequestId)]),
      ...(observedCompletedAt
        ? [eq(workflowStepRuns.completedAt, observedCompletedAt)]
        : [isNull(workflowStepRuns.completedAt)]),
    ))
    .returning({ id: workflowStepRuns.id });
  if (retryCas.length === 0) return null;

  if (reopenedByRecovery) {
    // 공식 복구가 run 재개(상태 CAS + 권한버전 범프)를 이미 수행했다.
  } else if (reopenGuardEnabled) {
    // [run-reopen-guard v1 + 봇 지적 교정] run 재오픈 CAS 를 스텝 리셋 쓰기 "보다 먼저" 둔다 —
    //   CAS 가 빈 반환하면 종결 run 의 스텝들이 리셋된 채 남는 불일치 잔류를 없앤다(거절은
    //   어떤 스텝 쓰기보다 앞선다). 상태 CAS + 권한버전 범프로 cancelled·completed 종결 run 은
    //   재오픈되지 않고, 경합 시 호출자가 이미 falsy 처리하는 null 로 실패닫힌다.
    const reopened = await input.db
      .update(workflowRuns)
      .set({
        status: "running",
        startedAt: context.run.startedAt ?? new Date(),
        completedAt: null,
        dispatchAuthorityVersion: sql`${workflowRuns.dispatchAuthorityVersion} + 1`,
      })
      .where(and(
        eq(workflowRuns.id, input.runId),
        eq(workflowRuns.companyId, input.companyId),
        inArray(workflowRuns.status, [...RUN_REOPEN_RESUMABLE_STATUSES]),
      ))
      .returning({ id: workflowRuns.id });
    if (reopened.length === 0) return null;
  } else {
    await input.db
      .update(workflowRuns)
      .set({
        status: "running",
        startedAt: context.run.startedAt ?? new Date(),
        completedAt: null,
      })
      .where(and(
        eq(workflowRuns.id, input.runId),
        eq(workflowRuns.companyId, input.companyId),
      ));
  }

  const refreshedStepRuns = await input.db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.runId));
  await input.resetUnlaunchedTerminalStepRuns(input.db, refreshedStepRuns);

  return {
    stepRunId: stepRun.id,
    result: await input.syncWorkflowRunState(input.db, input.runId),
  };
}
