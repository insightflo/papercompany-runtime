import { and, asc, eq, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";

const LEASE_MS = 30_000;
const BATCH_SIZE = 20;

type Continuation = typeof operatorDecisionContinuations.$inferSelect;

export function operatorDecisionContinuationStore(db: Db) {
  async function claimPending(row: Continuation, workerId: string, now: Date) {
    const attempt = row.attemptCount + 1;
    if (attempt > row.maxAttempts) return null;
    const idempotencyKey = `operator-decision-wake:${row.operatorDecisionId}:g${row.generation}:a${attempt}`;
    return db.update(operatorDecisionContinuations).set({
      state: "leased",
      attemptCount: attempt,
      idempotencyKey,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      errorCode: null,
      errorSummary: null,
      updatedAt: now,
    }).where(and(
      eq(operatorDecisionContinuations.id, row.id),
      eq(operatorDecisionContinuations.state, "pending"),
      eq(operatorDecisionContinuations.attemptCount, row.attemptCount),
      lte(operatorDecisionContinuations.nextAttemptAt, now),
    )).returning().then((rows) => rows[0] ?? null);
  }

  async function reclaimLease(row: Continuation, workerId: string, now: Date) {
    return db.update(operatorDecisionContinuations).set({
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    }).where(and(
      eq(operatorDecisionContinuations.id, row.id),
      eq(operatorDecisionContinuations.state, "leased"),
      lte(operatorDecisionContinuations.leaseExpiresAt, now),
    )).returning().then((rows) => rows[0] ?? null);
  }

  async function claimBatch(workerId: string, now = new Date()): Promise<Continuation[]> {
    const candidates = await db.select().from(operatorDecisionContinuations).where(or(
      and(
        eq(operatorDecisionContinuations.state, "pending"),
        lte(operatorDecisionContinuations.nextAttemptAt, now),
      ),
      and(
        eq(operatorDecisionContinuations.state, "leased"),
        lte(operatorDecisionContinuations.leaseExpiresAt, now),
      ),
    )).orderBy(asc(operatorDecisionContinuations.nextAttemptAt), asc(operatorDecisionContinuations.id)).limit(BATCH_SIZE);
    const claimed: Continuation[] = [];
    for (const row of candidates) {
      const result = row.state === "pending"
        ? await claimPending(row, workerId, now)
        : await reclaimLease(row, workerId, now);
      if (result) claimed.push(result);
    }
    return claimed;
  }

  async function getDispatchContext(continuationId: string) {
    const continuation = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.id, continuationId)).then((rows) => rows[0] ?? null);
    if (!continuation) return null;
    const decision = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.id, continuation.operatorDecisionId)).then((rows) => rows[0] ?? null);
    return decision ? { continuation, decision } : null;
  }

  async function setTarget(continuationId: string, workerId: string, targetAgentId: string) {
    return db.update(operatorDecisionContinuations).set({ targetAgentId, updatedAt: new Date() }).where(and(
      eq(operatorDecisionContinuations.id, continuationId),
      eq(operatorDecisionContinuations.state, "leased"),
      eq(operatorDecisionContinuations.leaseOwner, workerId),
    )).returning().then((rows) => rows[0] ?? null);
  }

  async function findProof(companyId: string, idempotencyKey: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    )).then((rows) => rows[0] ?? null);
  }

  async function writeTerminalActivity(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    row: Continuation,
    action: "operator_decision.continuation_accepted" | "operator_decision.continuation_blocked" | "operator_decision.continuation_exhausted",
    effectiveStatus: string,
    errorCode: string | null,
  ) {
    await tx.insert(activityLog).values({
      companyId: row.companyId,
      actorType: "system",
      actorId: "operator-decision-continuation-worker",
      action,
      entityType: "operator_decision",
      entityId: row.operatorDecisionId,
      details: {
        schemaVersion: 1,
        operatorDecisionId: row.operatorDecisionId,
        continuationId: row.id,
        generation: row.generation,
        attempt: row.attemptCount,
        targetAgentId: row.targetAgentId,
        wakeupRequestId: row.wakeupRequestId,
        effectiveStatus,
        errorCode,
      },
    });
  }

  async function accept(
    continuationId: string,
    workerId: string,
    targetAgentId: string,
    wakeupRequestId: string,
    now = new Date(),
  ) {
    return db.transaction(async (tx) => {
      const row = await tx.update(operatorDecisionContinuations).set({
        state: "accepted",
        targetAgentId,
        wakeupRequestId,
        acceptedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorSummary: null,
        updatedAt: now,
      }).where(and(
        eq(operatorDecisionContinuations.id, continuationId),
        eq(operatorDecisionContinuations.state, "leased"),
        eq(operatorDecisionContinuations.leaseOwner, workerId),
      )).returning().then((rows) => rows[0] ?? null);
      if (row) await writeTerminalActivity(tx, row, "operator_decision.continuation_accepted", "queued", null);
      return row;
    });
  }

  async function block(
    continuationId: string,
    workerId: string,
    errorCode: "issue_missing" | "issue_unassigned" | "issue_terminal",
    now = new Date(),
  ) {
    return db.transaction(async (tx) => {
      const row = await tx.update(operatorDecisionContinuations).set({
        state: "blocked",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode,
        errorSummary: null,
        updatedAt: now,
      }).where(and(
        eq(operatorDecisionContinuations.id, continuationId),
        eq(operatorDecisionContinuations.state, "leased"),
        eq(operatorDecisionContinuations.leaseOwner, workerId),
      )).returning().then((rows) => rows[0] ?? null);
      if (row) await writeTerminalActivity(tx, row, "operator_decision.continuation_blocked", "blocked", errorCode);
      return row;
    });
  }

  async function failDispatch(
    continuationId: string,
    workerId: string,
    now = new Date(),
  ) {
    return db.transaction(async (tx) => {
      const current = await tx.select().from(operatorDecisionContinuations).where(and(
        eq(operatorDecisionContinuations.id, continuationId),
        eq(operatorDecisionContinuations.state, "leased"),
        eq(operatorDecisionContinuations.leaseOwner, workerId),
      )).then((rows) => rows[0] ?? null);
      if (!current) return null;
      const exhausted = current.attemptCount >= current.maxAttempts;
      const delayMs = current.attemptCount === 1 ? 5_000 : 30_000;
      const row = await tx.update(operatorDecisionContinuations).set({
        state: exhausted ? "exhausted" : "pending",
        nextAttemptAt: exhausted ? current.nextAttemptAt : new Date(now.getTime() + delayMs),
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: exhausted ? "attempts_exhausted" : "dispatch_failed",
        errorSummary: null,
        updatedAt: now,
      }).where(and(
        eq(operatorDecisionContinuations.id, continuationId),
        eq(operatorDecisionContinuations.state, "leased"),
        eq(operatorDecisionContinuations.leaseOwner, workerId),
      )).returning().then((rows) => rows[0] ?? null);
      if (row && exhausted) {
        await writeTerminalActivity(tx, row, "operator_decision.continuation_exhausted", "exhausted", "attempts_exhausted");
      }
      return row;
    });
  }

  return { claimBatch, getDispatchContext, setTarget, findProof, accept, block, failDispatch };
}
