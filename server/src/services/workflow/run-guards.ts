/**
 * Workflow Run Guards
 *
 * Pre-execution checks to ensure workflow runs can proceed safely.
 */

import type { Db } from "../../packages/db/src/client.js";
import { workflowDefinitions, workflowRuns } from "../../packages/db/src/schema/index.js";
import { eq, and, sql } from "drizzle-orm";

/**
 * Result of a guard check.
 */
export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a workflow run can be started.
 */
export async function canStartWorkflowRun(
  db: Db,
  workflowId: string,
  companyId: string,
): Promise<GuardResult> {
  // Check if workflow exists and belongs to company
  const workflow = await db
    .select()
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.id, workflowId),
        eq(workflowDefinitions.companyId, companyId),
      ),
    )
    .limit(1);

  if (!workflow[0]) {
    return {
      allowed: false,
      reason: "Workflow not found or access denied",
    };
  }

  // Check for too many concurrent runs (prevent runaway execution)
  const runningCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.status, "running"),
      ),
    );

  if ((runningCount[0]?.count ?? 0) >= 5) {
    return {
      allowed: false,
      reason: "Too many concurrent runs (max 5)",
    };
  }

  return { allowed: true };
}

/**
 * Check if a workflow run can be cancelled.
 */
export async function canCancelWorkflowRun(
  db: Db,
  runId: string,
  companyId: string,
): Promise<GuardResult> {
  const run = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.companyId, companyId),
      ),
    )
    .limit(1);

  if (!run[0]) {
    return {
      allowed: false,
      reason: "Workflow run not found or access denied",
    };
  }

  const status = run[0].status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return {
      allowed: false,
      reason: `Cannot cancel run in status: ${status}`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a workflow definition can be modified.
 */
export async function canModifyWorkflowDefinition(
  db: Db,
  workflowId: string,
  companyId: string,
): Promise<GuardResult> {
  const activeRuns = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.companyId, companyId),
        eq(workflowRuns.status, "running"),
      ),
    );

  if ((activeRuns[0]?.count ?? 0) > 0) {
    return {
      allowed: false,
      reason: "Cannot modify workflow with active runs",
    };
  }

  return { allowed: true };
}

/**
 * Check if a workflow definition can be deleted.
 */
export async function canDeleteWorkflowDefinition(
  db: Db,
  workflowId: string,
  companyId: string,
): Promise<GuardResult> {
  // Check for any runs (not just active) - this is configurable policy
  const anyRuns = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.companyId, companyId),
      ),
    );

  if ((anyRuns[0]?.count ?? 0) > 0) {
    return {
      allowed: false,
      reason: "Cannot delete workflow with existing run history",
    };
  }

  return { allowed: true };
}
