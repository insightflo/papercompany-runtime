import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowStepRuns,
} from "@paperclipai/db";

export async function hasActiveWorkflowReworkIteration(
  db: Db,
  input: { readonly companyId: string; readonly workflowRunId: string },
): Promise<boolean> {
  const active = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      gt(workflowStepRuns.iterationIndex, 0),
      sql`(
        ${workflowStepRuns.status} = 'running'
        OR EXISTS (
          SELECT 1 FROM ${issues}
          WHERE ${issues.id} = ${workflowStepRuns.issueId}
            AND ${issues.status} IN ('in_progress', 'in_review')
        )
        OR EXISTS (
          SELECT 1 FROM ${heartbeatRuns}
          WHERE ${heartbeatRuns.issueId} = ${workflowStepRuns.issueId}
            AND ${heartbeatRuns.status} IN ('queued', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM ${agentWakeupRequests}
          WHERE ${agentWakeupRequests.companyId} = ${input.companyId}
            AND ${agentWakeupRequests.issueId} = ${workflowStepRuns.issueId}
            AND ${agentWakeupRequests.workflowRunId} = ${input.workflowRunId}
            AND ${agentWakeupRequests.status} IN ('queued', 'claimed', 'deferred_issue_execution')
        )
      )`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return active !== null;
}
