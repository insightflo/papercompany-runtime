import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  operatorDecisionContinuations,
  type operatorDecisions,
} from "@paperclipai/db";
import type {
  OperatorDecisionContinuationView,
  OperatorDecisionEffectiveStatus,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";

export interface ContinuationStatusInput {
  continuation: typeof operatorDecisionContinuations.$inferSelect;
  wakeup: typeof agentWakeupRequests.$inferSelect | null;
  run: typeof heartbeatRuns.$inferSelect | null;
  issue: Pick<typeof issues.$inferSelect, "id" | "status" | "assigneeAgentId"> | null;
  targetAgent: Pick<typeof agents.$inferSelect, "id" | "status"> | null;
  now: Date;
}

export interface DerivedContinuationStatus {
  effectiveStatus: OperatorDecisionEffectiveStatus;
  errorCode: string | null;
  attention: boolean;
}

const terminalRunMapping: Record<string, [OperatorDecisionEffectiveStatus, string | null, boolean]> = {
  succeeded: ["completed", null, false],
  failed: ["failed", "heartbeat_failed", true],
  cancelled: ["cancelled", "heartbeat_cancelled", true],
  timed_out: ["timed_out", "heartbeat_timed_out", true],
};
const terminalRequestMapping: Record<string, [OperatorDecisionEffectiveStatus, string | null, boolean]> = {
  completed: ["completed", null, false],
  failed: ["failed", "heartbeat_failed", true],
  cancelled: ["cancelled", "heartbeat_cancelled", true],
  skipped: ["skipped", "heartbeat_skipped", true],
  timed_out: ["timed_out", "heartbeat_timed_out", true],
};

function derived(tuple: [OperatorDecisionEffectiveStatus, string | null, boolean]): DerivedContinuationStatus {
  return { effectiveStatus: tuple[0], errorCode: tuple[1], attention: tuple[2] };
}

export function deriveOperatorDecisionContinuationStatus(
  input: ContinuationStatusInput,
): DerivedContinuationStatus {
  const { continuation, wakeup, run, issue, targetAgent, now } = input;
  if (continuation.state === "blocked") {
    return { effectiveStatus: "blocked", errorCode: continuation.errorCode, attention: true };
  }
  if (continuation.state === "exhausted") {
    return { effectiveStatus: "exhausted", errorCode: "attempts_exhausted", attention: true };
  }
  if (continuation.state === "pending") {
    if (now.getTime() > continuation.nextAttemptAt.getTime() + 30_000) {
      return { effectiveStatus: "pending", errorCode: "dispatch_delayed", attention: true };
    }
    return {
      effectiveStatus: "pending",
      errorCode: continuation.errorCode === "dispatch_failed" ? "dispatch_failed" : null,
      attention: false,
    };
  }
  if (continuation.state === "leased") {
    const expired = continuation.leaseExpiresAt !== null && continuation.leaseExpiresAt.getTime() < now.getTime();
    return { effectiveStatus: "dispatching", errorCode: expired ? "lease_expired" : null, attention: expired };
  }
  if (continuation.state !== "accepted" || !wakeup) {
    return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
  }
  if (run && terminalRunMapping[run.status]) return derived(terminalRunMapping[run.status]!);
  if (terminalRequestMapping[wakeup.status]) return derived(terminalRequestMapping[wakeup.status]!);
  if (wakeup.status === "coalesced" && run && ["queued", "running"].includes(run.status)) {
    return { effectiveStatus: "coalesced", errorCode: null, attention: false };
  }
  if (wakeup.status === "claimed" && run && ["queued", "running"].includes(run.status)) {
    return { effectiveStatus: "running", errorCode: null, attention: false };
  }
  if (["coalesced", "claimed"].includes(wakeup.status)) {
    return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
  }
  if (["queued", "deferred_issue_execution"].includes(wakeup.status)) {
    if (!issue) return { effectiveStatus: "blocked", errorCode: "issue_missing", attention: true };
    if (!issue.assigneeAgentId) return { effectiveStatus: "blocked", errorCode: "issue_unassigned", attention: true };
    if (["done", "cancelled"].includes(issue.status)) {
      return { effectiveStatus: "issue_terminal", errorCode: "issue_terminal", attention: true };
    }
    if (issue.assigneeAgentId !== continuation.targetAgentId) {
      return { effectiveStatus: "assignee_changed", errorCode: "assignee_changed", attention: true };
    }
    if (!targetAgent || ["paused", "terminated", "pending_approval"].includes(targetAgent.status)) {
      return { effectiveStatus: "agent_unrunnable", errorCode: "agent_unrunnable", attention: true };
    }
    return {
      effectiveStatus: wakeup.status === "queued" ? "queued" : "deferred",
      errorCode: null,
      attention: false,
    };
  }
  return { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true };
}

async function loadContinuationProjection(
  db: Db,
  decisionId: string,
  now: Date,
): Promise<{ view: OperatorDecisionContinuationView; attention: boolean; updatedAt: Date } | null> {
  const continuation = await db.select().from(operatorDecisionContinuations)
    .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId))
    .then((rows) => rows[0] ?? null);
  if (!continuation) return null;
  const wakeup = continuation.wakeupRequestId
    ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, continuation.wakeupRequestId)).then((rows) => rows[0] ?? null)
    : null;
  const run = wakeup?.runId
    ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakeup.runId)).then((rows) => rows[0] ?? null)
    : null;
  const issue = continuation.issueId
    ? await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(eq(issues.id, continuation.issueId)).then((rows) => rows[0] ?? null)
    : null;
  const targetAgent = continuation.targetAgentId
    ? await db.select({ id: agents.id, status: agents.status }).from(agents)
      .where(eq(agents.id, continuation.targetAgentId)).then((rows) => rows[0] ?? null)
    : null;
  const status = deriveOperatorDecisionContinuationStatus({ continuation, wakeup, run, issue, targetAgent, now });
  return {
    view: {
      id: continuation.id,
      state: continuation.state as OperatorDecisionContinuationView["state"],
      generation: continuation.generation,
      attemptCount: continuation.attemptCount,
      maxAttempts: continuation.maxAttempts,
      manualRetryCount: continuation.manualRetryCount,
      maxManualRetries: 2,
      nextAttemptAt: continuation.nextAttemptAt.toISOString(),
      leaseExpiresAt: continuation.leaseExpiresAt?.toISOString() ?? null,
      targetAgentId: continuation.targetAgentId,
      wakeupRequestId: continuation.wakeupRequestId,
      effectiveStatus: status.effectiveStatus,
      errorCode: status.errorCode,
    },
    attention: status.attention,
    updatedAt: continuation.updatedAt,
  };
}

export async function loadOperatorDecisionProjection(
  db: Db,
  row: typeof operatorDecisions.$inferSelect,
  now = new Date(),
): Promise<{ view: OperatorDecisionView; attention: boolean; continuationUpdatedAt: Date | null }> {
  const continuation = await loadContinuationProjection(db, row.id, now);
  const requestedBy = row.requestedByAgentId
    ? { type: "agent" as const, id: row.requestedByAgentId }
    : row.requestedByUserId
      ? { type: "user" as const, id: row.requestedByUserId }
      : null;
  return {
    view: {
      id: row.id,
      companyId: row.companyId,
      schemaVersion: 1,
      requestKey: row.requestKey,
      status: row.status as OperatorDecisionView["status"],
      priority: row.priority as OperatorDecisionView["priority"],
      interactionType: row.interactionType as OperatorDecisionView["interactionType"],
      title: row.title,
      description: row.description,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      sourceContext: row.sourceContext,
      definition: row.definition,
      result: row.result,
      issueId: row.issueId,
      continuationMode: row.continuationMode as OperatorDecisionView["continuationMode"],
      requestedBy,
      resolvedByUserId: row.resolvedByUserId,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      continuation: continuation?.view ?? null,
    },
    attention: continuation?.attention ?? false,
    continuationUpdatedAt: continuation?.updatedAt ?? null,
  };
}
