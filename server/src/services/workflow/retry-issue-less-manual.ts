import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { isRunReopenGuardEnabled, RUN_REOPEN_RESUMABLE_STATUSES } from "./run-reopen-guard-flag.js";
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
  loadWorkflowExecutionContext: (db: Db, runId: string) => Promise<{
    run: { id: string; companyId: string; startedAt: Date | null };
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
  const reopenGuardEnabled = await isRunReopenGuardEnabled(input.db);
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

  const refreshedStepRuns = await input.db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.runId));
  await input.resetUnlaunchedTerminalStepRuns(input.db, refreshedStepRuns);

  if (reopenGuardEnabled) {
    // [run-reopen-guard v1] run 재오픈에도 상태 CAS + 권한버전 범프 — cancelled·completed 등 종결
    //   run 은 재오픈되지 않고, 경합으로 CAS 가 빈 반환하면 호출자가 이미 falsy 처리하는 null 로
    //   실패닫힌다(스텝 리셋은 이미 일어났지만 run 권위는 보존된다).
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

  return {
    stepRunId: stepRun.id,
    result: await input.syncWorkflowRunState(input.db, input.runId),
  };
}
