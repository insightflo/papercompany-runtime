import { and, eq, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { FollowupTx } from "./heartbeat-followup-promotion.js";
import { lifecycleInFlightClause } from "./heartbeat-finalization/lifecycle-active.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";

type Issue = typeof issues.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;
type Admission = { kind: "waiting" | "superseded" } | { kind: "ready"; issue: Issue | null };

/**
 * Queued promotion only; initial mention admission keeps its existing exception.
 * Recovery owns authority -> wake locks. Release owns issue -> wake locks, so NEVER
 * wait for an issue here while holding a wake. A skipped row is retried by the
 * existing resumeQueuedRuns sweep, not treated as a missing issue or failed wake.
 */
export async function lockQueuedIssueAdmission(tx: FollowupTx, input: {
  request: Wake; issueId: string | null; contextSnapshot: Record<string, unknown>;
}): Promise<Admission> {
  const { request, issueId, contextSnapshot } = input;
  if (!issueId) return { kind: "ready", issue: null };
  const scope = and(eq(issues.id, issueId), eq(issues.companyId, request.companyId));
  const [issue] = await tx.select().from(issues).where(scope).for("update", { skipLocked: true });
  if (!issue) {
    const [exists] = await tx.select({ id: issues.id }).from(issues).where(scope);
    return exists ? { kind: "waiting" } : { kind: "ready", issue: null };
  }

  const wakeReason = readNonEmptyString(request.reason)
    ?? readNonEmptyString(contextSnapshot.wakeReason);
  const mention = wakeReason === "issue_comment_mentioned";
  // Only the replaceable assignment notification is superseded. Structured
  // continuations (for example plan rework and workflow resume) carry context
  // that a later generic assignment wake cannot reconstruct.
  if (!mention && wakeReason === "issue_assigned"
    && issue.assigneeAgentId !== request.agentId) {
    // Supersession is not an execution failure: never create a run/failure cascade
    // or alter the replacement assignee's checkout, even if that run is finishing.
    const now = new Date();
    await tx.update(agentWakeupRequests).set({
      status: "completed", finishedAt: now, error: null, updatedAt: now,
    }).where(eq(agentWakeupRequests.id, request.id));
    return { kind: "superseded" };
  }
  return { kind: "ready", issue };
}

/** Caller retains the issue lock through insertion/checkout. Never clear another run's ownership. */
export async function queuedIssueExecutionIsBusy(tx: FollowupTx, issue: Issue): Promise<boolean> {
  if (issue.executionRunId || issue.checkoutRunId) return true;
  // Match initial admission's legacy linkage too: mention/legacy runs may have no
  // issue lock. Lifecycle-active finalization still owns its execution until settled.
  const inFlight = await lifecycleInFlightClause(tx as unknown as Db);
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), inFlight,
    or(eq(heartbeatRuns.issueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`),
  )).limit(1);
  return Boolean(run);
}
