import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { ToolProgressError } from "./progress-policy.js";

export type ProgressTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ProgressScope = {
  companyId: string; toolId: string; requestId: string; adapterType: "builtin" | "http";
  workflowRunId?: string | null; stepId?: string | null;
};
export type ProgressBinding = {
  workflowRunId: string | null; stepId: string | null; stepRunId: string | null;
  executionGeneration: number | null; retryCount: number | null; iterationIndex: number | null;
};
export async function lockProgressScope(tx: ProgressTransaction, scope: Pick<ProgressScope, "companyId" | "workflowRunId" | "stepId">): Promise<ProgressBinding> {
  if (!scope.workflowRunId && !scope.stepId) return {
    workflowRunId: null, stepId: null, stepRunId: null, executionGeneration: null, retryCount: null, iterationIndex: null,
  };
  if (!scope.workflowRunId || !scope.stepId) throw new ToolProgressError(422, "tool_progress_invalid_scope");
  const [run] = await tx.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, scope.companyId))).for("share");
  if (!run) throw new ToolProgressError(422, "tool_progress_invalid_scope");
  const [step] = await tx.select().from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.workflowRunId, run.id), eq(workflowStepRuns.stepId, scope.stepId))).for("share");
  if (!step) throw new ToolProgressError(422, "tool_progress_invalid_scope");
  // Status can prohibit continued work, but never authorizes a dispatch or completion.
  if (!["pending", "running"].includes(run.status) || ["completed", "failed", "skipped", "cancelled"].includes(step.status)) {
    throw new ToolProgressError(409, "tool_progress_scope_replaced");
  }
  return { workflowRunId: run.id, stepId: step.stepId, stepRunId: step.id,
    executionGeneration: step.executionGeneration, retryCount: step.retryCount, iterationIndex: step.iterationIndex };
}
export async function progressScopeMatches(tx: ProgressTransaction, row: ProgressBinding & { companyId: string }): Promise<boolean> {
  try {
    const binding = await lockProgressScope(tx, row);
    return binding.stepRunId === row.stepRunId && binding.executionGeneration === row.executionGeneration &&
      binding.retryCount === row.retryCount && binding.iterationIndex === row.iterationIndex;
  } catch (error) {
    if (error instanceof ToolProgressError) return false;
    throw error;
  }
}
