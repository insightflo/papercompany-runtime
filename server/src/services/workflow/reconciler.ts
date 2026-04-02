/**
 * Workflow Reconciler
 *
 * Handles automatic reconciliation of workflow state after failures or interruptions.
 * Replaces PluginContext with direct database access via Drizzle.
 */

import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns, issues } from "@paperclipai/db";
import { eq, and, sql } from "drizzle-orm";

/**
 * Reconciliation result for a single workflow run.
 */
export interface ReconciliationResult {
  runId: string;
  action: "recovered" | "failed" | "skipped";
  reason?: string;
}

/**
 * Reconciles all stuck workflow runs.
 *
 * A run is considered stuck if it's in "running" status and hasn't been updated
 * within the timeout period.
 *
 * @param db - Database instance.
 * @param timeoutMinutes - Timeout in minutes before considering a run stuck.
 * @returns List of reconciliation results.
 */
export async function reconcileStuckWorkflowRuns(
  db: Db,
  timeoutMinutes: number = 60,
): Promise<ReconciliationResult[]> {
  const timeout = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const stuckRuns = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        sql`${workflowRuns.startedAt} < ${timeout}`,
      ),
    );

  const results: ReconciliationResult[] = [];

  for (const run of stuckRuns) {
    try {
      // Check if any step runs are still pending
      const pendingSteps = await db
        .select()
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, run.id),
            eq(workflowStepRuns.status, "pending"),
          ),
        );

      if (pendingSteps.length > 0) {
        // Mark pending steps as failed
        for (const step of pendingSteps) {
          await db
            .update(workflowStepRuns)
            .set({ status: "failed", completedAt: new Date() })
            .where(eq(workflowStepRuns.id, step.id));
        }
      }

      // Mark the run as failed
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));

      results.push({
        runId: run.id,
        action: "recovered",
        reason: "Marked stuck run as failed",
      });
    } catch (error) {
      results.push({
        runId: run.id,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Reconciles orphan workflow step runs (step runs without a valid workflow run).
 *
 * @param db - Database instance.
 * @returns Number of orphan step runs cleaned up.
 */
export async function reconcileOrphanStepRuns(db: Db): Promise<number> {
  // Find step runs whose workflow run doesn't exist or is in a terminal state
  const orphanStepRuns = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(sql`
      ${workflowStepRuns.workflowRunId} NOT IN (
        SELECT ${workflowRuns.id} FROM ${workflowRuns} WHERE ${workflowRuns.status} IN ('pending', 'running')
      )
    `);

  let cleaned = 0;
  for (const stepRun of orphanStepRuns) {
    try {
      await db
        .delete(workflowStepRuns)
        .where(eq(workflowStepRuns.id, stepRun.id));
      cleaned++;
    } catch {
      // Skip if delete fails
    }
  }

  return cleaned;
}

/**
 * Full reconciliation workflow.
 *
 * Runs all reconciliation checks and returns a summary.
 *
 * @param db - Database instance.
 * @param options - Reconciliation options.
 */
export async function reconcileWorkflow(
  db: Db,
  options: { timeoutMinutes?: number } = {},
): Promise<{
    stuckRunsRecovered: number;
    orphanStepsCleaned: number;
  }> {
  const timeoutMinutes = options.timeoutMinutes ?? 60;

  const stuckResults = await reconcileStuckWorkflowRuns(db, timeoutMinutes);
  const orphanStepsCleaned = await reconcileOrphanStepRuns(db);

  return {
    stuckRunsRecovered: stuckResults.filter((r) => r.action === "recovered").length,
    orphanStepsCleaned,
  };
}
