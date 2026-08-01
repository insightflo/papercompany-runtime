import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { loadOperatorDecisionProjection } from "./operator-decision-view.js";
import { operatorDecisionReadService } from "./operator-decisions-read.js";

function retryConflict(id: string, status: string) {
  return conflict("Operator decision continuation retry conflict", { operatorDecisionId: id, status });
}

export function operatorDecisionContinuationRetryService(db: Db) {
  const read = operatorDecisionReadService(db);

  async function retryContinuation(decisionId: string, requestedByUserId: string) {
    const decision = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId))
      .then((rows) => rows[0] ?? null);
    if (!decision) throw notFound("Operator decision not found");
    const continuation = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId))
      .then((rows) => rows[0] ?? null);
    if (!continuation) throw retryConflict(decisionId, "missing_continuation");
    if (continuation.manualRetryCount >= 2 || !continuation.issueId || continuation.errorCode === "issue_missing") {
      throw retryConflict(decisionId, continuation.state);
    }
    const projection = await loadOperatorDecisionProjection(db, decision);
    const effectiveStatus = projection.view.continuation?.effectiveStatus ?? "blocked";
    const issue = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(and(eq(issues.id, continuation.issueId), eq(issues.companyId, continuation.companyId)))
      .then((rows) => rows[0] ?? null);
    const repairedBlocked = continuation.state === "blocked" && (
      (continuation.errorCode === "issue_unassigned" && Boolean(issue?.assigneeAgentId)) ||
      (continuation.errorCode === "issue_terminal" && Boolean(issue) && !["done", "cancelled"].includes(issue!.status))
    );
    const retryableTerminal = ["skipped", "failed", "cancelled", "timed_out", "assignee_changed"].includes(effectiveStatus);
    if (continuation.state !== "exhausted" && !repairedBlocked && !retryableTerminal) {
      throw retryConflict(decisionId, effectiveStatus);
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      if (effectiveStatus === "assignee_changed") {
        if (!continuation.wakeupRequestId) throw retryConflict(decisionId, effectiveStatus);
        const cancelled = await tx.update(agentWakeupRequests).set({
          status: "cancelled",
          error: "Superseded by operator decision retry",
          finishedAt: now,
          updatedAt: now,
        }).where(and(
          eq(agentWakeupRequests.id, continuation.wakeupRequestId),
          eq(agentWakeupRequests.companyId, continuation.companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
        )).returning({ id: agentWakeupRequests.id });
        if (cancelled.length !== 1) throw retryConflict(decisionId, effectiveStatus);
      }
      const updated = await tx.update(operatorDecisionContinuations).set({
        state: "pending",
        generation: continuation.generation + 1,
        manualRetryCount: continuation.manualRetryCount + 1,
        attemptCount: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        targetAgentId: null,
        wakeupRequestId: null,
        idempotencyKey: null,
        errorCode: null,
        errorSummary: null,
        acceptedAt: null,
        updatedAt: now,
      }).where(and(
        eq(operatorDecisionContinuations.id, continuation.id),
        eq(operatorDecisionContinuations.state, continuation.state),
        eq(operatorDecisionContinuations.generation, continuation.generation),
        eq(operatorDecisionContinuations.manualRetryCount, continuation.manualRetryCount),
      )).returning({ id: operatorDecisionContinuations.id });
      if (updated.length !== 1) throw retryConflict(decisionId, effectiveStatus);
      await tx.insert(activityLog).values({
        companyId: continuation.companyId,
        actorType: "user",
        actorId: requestedByUserId,
        action: "operator_decision.continuation_retried",
        entityType: "operator_decision",
        entityId: decisionId,
        details: {
          schemaVersion: 1,
          operatorDecisionId: decisionId,
          continuationId: continuation.id,
          previousGeneration: continuation.generation,
          newGeneration: continuation.generation + 1,
          requestedByUserId,
          requestedAt: now.toISOString(),
          previousEffectiveStatus: effectiveStatus,
          oldWakeupRequestId: continuation.wakeupRequestId,
        },
      });
    });
    const updatedDecision = await read.getRequired(decisionId);
    return { decision: updatedDecision, applied: true, continuation: updatedDecision.continuation };
  }

  return { retryContinuation };
}
