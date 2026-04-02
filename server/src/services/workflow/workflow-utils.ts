/**
 * Workflow Utilities
 *
 * Helper functions for workflow operations.
 */

import { workflowDefinitions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";

/**
 * Converts a workflow definition to a minimal representation for execution.
 */
export function toExecutionWorkflow(definition: {
  id: string;
  name: string;
  stepsJson: unknown;
}): { id: string; name: string; steps: WorkflowStep[] } {
  return {
    id: definition.id,
    name: definition.name,
    steps: definition.stepsJson as WorkflowStep[],
  };
}

/**
 * Checks if a workflow definition exists.
 */
export async function workflowExists(
  db: Db,
  id: string,
): Promise<boolean> {
  const result = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .limit(1);

  return !!result[0];
}

/**
 * Formats a workflow error for display.
 */
export function formatWorkflowError(error: Error): string {
  return `Workflow Error: ${error.message}`;
}

/**
 * Computes the completion percentage of a workflow run.
 */
export function computeCompletionPercentage(
  totalSteps: number,
  completedSteps: number,
): number {
  if (totalSteps === 0) return 100;
  return Math.round((completedSteps / totalSteps) * 100);
}

/**
 * Determines the next steps to execute in a workflow.
 */
export function findNextSteps(
  allSteps: WorkflowStep[],
  completedStepIds: Set<string>,
): WorkflowStep[] {
  return allSteps.filter((step) => {
    // Skip already completed
    if (completedStepIds.has(step.id)) return false;

    // Check if all dependencies are completed
    return step.dependencies.every((dep) => completedStepIds.has(dep));
  });
}

/**
 * Creates a summary of a workflow execution.
 */
export function createExecutionSummary(
  run: { id: string; status: string; createdAt: Date; completedAt: Date | null },
  stepRuns: Array<{ stepId: string; status: string; completedAt: Date | null }>,
): {
  runId: string;
  status: string;
  duration: number | null;
  stepCount: number;
  completedSteps: number;
  failedSteps: number;
} {
  const completedSteps = stepRuns.filter((s) => s.status === "completed").length;
  const failedSteps = stepRuns.filter((s) => s.status === "failed").length;
  const duration = run.completedAt
    ? run.completedAt.getTime() - run.createdAt.getTime()
    : null;

  return {
    runId: run.id,
    status: run.status,
    duration,
    stepCount: stepRuns.length,
    completedSteps,
    failedSteps,
  };
}
