import type { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowExecutionResult } from "./types.js";

export function mapWorkflowExecutionResult(
  run: typeof workflowRuns.$inferSelect,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): WorkflowExecutionResult {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    missionId: run.missionId,
    status: run.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: run.completedAt,
    error: run.status === "failed" ? "One or more workflow steps failed" : undefined,
    stepRuns: stepRuns.map((stepRun) => ({
      id: stepRun.id,
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId,
      status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
    })),
  };
}
