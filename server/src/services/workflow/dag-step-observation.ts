import type { ConditionalStepObservation } from "./conditional-skip-settlement.js";
import type { workflowStepRuns } from "@paperclipai/db";

export function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, typeof workflowStepRuns.$inferSelect> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

export function toConditionalStepObservation(row: typeof workflowStepRuns.$inferSelect): ConditionalStepObservation {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    stepId: row.stepId,
    status: row.status,
    issueId: row.issueId,
    startedAt: row.startedAt,
    lastDispatchAttemptAt: row.lastDispatchAttemptAt,
    dispatchReadyAt: row.dispatchReadyAt,
    executionGeneration: row.executionGeneration,
    metadata: row.metadata,
  };
}
