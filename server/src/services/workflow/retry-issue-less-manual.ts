import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
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

  return {
    stepRunId: stepRun.id,
    result: await input.syncWorkflowRunState(input.db, input.runId),
  };
}
