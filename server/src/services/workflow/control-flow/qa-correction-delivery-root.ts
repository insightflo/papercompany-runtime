import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, missions, workflowRuns,
  workflowStepRuns, workflowStepOutputBindings, withTxTimeout, DEFAULT_TX_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { asBoolean, parseObject } from "../../../adapters/utils.js";
import { budgetService } from "../../budgets.js";
import { lifecycleInFlightClause } from "../../heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "../../heartbeat-mission-dedup.js";
import { insertWorkflowWakeRequest } from "../../heartbeat-workflow-wake.js";
import { lockQualityAttemptBudget } from "../../quality/retry-budget.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup, readQaCorrectionFollowupDb } from "./qa-correction-followup.js";
import { readIssuedQaCorrection } from "./qa-correction-reader.js";
import { assertDeliveryInput, assertDeliveryScope, assertDeliverySignature, assertDeliveryWake, findDeliveryEvent,
  insertCorrectionDelivery, persistDeliveryIdentity, readQaCorrectionDelivery, readDeliveryWakeCandidates as wakes, requireDelivery,
  type CorrectionDeliveryInput, type CorrectionDeliveryResult, type DeliveryHistory, type DeliveryTx, type DeliveryWake,
} from "./qa-correction-delivery-receipt.js";

export type { CorrectionDeliveryInput, CorrectionDeliveryResult };
export type WriteLinkedCorrectionRun = (tx: DeliveryTx, wake: DeliveryWake) => Promise<unknown>;
export type CorrectionDeliveryOptions = {
  transactionProfile?: "public_callback" | "recovery_skip_locked";
};
class ReceiptAppeared extends Error {}
class PendingAppeared extends Error {}
// Private control flow only: neither signal proves authority or a successful historical relation.
class ReceiptConflict extends Error {}
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const owner = (row: typeof issues.$inferSelect) => ({
  id: row.id, executionRunId: row.executionRunId, checkoutRunId: row.checkoutRunId,
  executionAgentNameKey: row.executionAgentNameKey, executionLockedAt: row.executionLockedAt,
});
const targets = (h: DeliveryHistory) => [h.issued.preparation.producer, h.followup.target,
  ...h.issued.preparation.authority.verdicts.map(v => v.qa), ...h.issued.preparation.bindings.map(b => b.consumer)];

async function issueRows(db: Pick<Db, "select">, i: CorrectionDeliveryInput, h: DeliveryHistory) {
  return db.select().from(issues).where(and(eq(issues.companyId, i.companyId),
    inArray(issues.id, sorted(targets(h).map(t => t.issueId))))).orderBy(asc(issues.id));
}
async function heartbeatSet(db: Pick<Db, "select">, i: CorrectionDeliveryInput, h: DeliveryHistory,
  rows: Awaited<ReturnType<typeof issueRows>>, pending: DeliveryWake[]) {
  const p = h.issued.preparation, ids = [
    ...rows.flatMap(r => [r.executionRunId, r.checkoutRunId]),
    ...pending.map(w => w.runId), ...p.authority.verdicts.map(v => v.heartbeatRunId),
    ...h.revisions.map(r => r.workflowProducer?.heartbeatRunId),
    ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : []),
  ].filter((id): id is string => !!id);
  return db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, i.companyId),
    or(eq(heartbeatRuns.agentId, i.agentId), inArray(heartbeatRuns.issueId, rows.map(r => r.id)),
      inArray(heartbeatRuns.id, ids)))).orderBy(asc(heartbeatRuns.id));
}
async function observe(db: Db, i: CorrectionDeliveryInput) {
  // This is the real stage7 file/DB capability; never synthesize or replace its WeakMap token.
  const selected = await readQaCorrectionFollowupDb(db, i.ref, readIssuedQaCorrection);
  await assertDeliveryScope(db, i, selected);
  const token = await observeQaCorrectionFollowup(db, i.ref, readIssuedQaCorrection);
  const pending = await wakes(db, i), rows = await issueRows(db, i, selected);
  const heartbeats = await heartbeatSet(db, i, selected, rows, pending);
  const owners = sorted(rows.flatMap(r => [r.executionRunId, r.checkoutRunId]).filter((id): id is string => !!id));
  requireDelivery(owners.every(id => heartbeats.some(h => h.id === id)), "owner");
  return { token, selected, pending, rows, heartbeats };
}
type Observed = Awaited<ReturnType<typeof observe>>;

async function lockPrefix(tx: DeliveryTx, i: CorrectionDeliveryInput, o: Observed) {
  const p = o.selected.issued.preparation;
  if (p.authority.kind === "quality_current_output") {
    await lockQualityAttemptBudget(tx, { companyId: i.companyId, actionId: p.authority.actionId, now: new Date() });
  }
  await tx.select().from(missions).where(and(eq(missions.companyId, i.companyId), eq(missions.id, i.missionId)))
    .for("no key update");
  await tx.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, i.companyId), eq(workflowRuns.id, i.workflowRunId)))
    .for("no key update");
  // Run serialization precedes issue/HB acquisition. Roll back before opening another read snapshot.
  if (await findDeliveryEvent(tx, i)) throw new ReceiptAppeared();
  await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, i.companyId),
    inArray(heartbeatRuns.id, o.heartbeats.map(h => h.id)))).orderBy(asc(heartbeatRuns.id)).for("update");
  await tx.select().from(issues).where(and(eq(issues.companyId, i.companyId),
    inArray(issues.id, o.rows.map(r => r.id)))).orderBy(asc(issues.id)).for("update");
  const currentRows = await issueRows(tx, i, o.selected);
  const currentHeartbeats = await heartbeatSet(tx, i, o.selected, currentRows, await wakes(tx, i));
  requireDelivery(same(currentRows.map(owner), o.rows.map(owner))
    && same(currentHeartbeats.map(h => h.id), o.heartbeats.map(h => h.id)), "owner_changed");
  await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, i.workflowRunId),
    inArray(workflowStepRuns.id, sorted(targets(o.selected).map(t => t.stepRunId)))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  const productIds = sorted([...p.sources.map(s => s.productId), ...o.selected.issued.applied.revisions.map(r => r.workProductId)]);
  await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, i.companyId),
    inArray(issueWorkProducts.id, productIds))).orderBy(asc(issueWorkProducts.id)).for("update");
  await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, i.companyId),
    eq(workflowStepOutputBindings.workflowRunId, i.workflowRunId), inArray(workflowStepOutputBindings.id, p.bindings.map(b => b.bindingId))))
    .orderBy(asc(workflowStepOutputBindings.id)).for("update");
  const candidates = await wakes(tx, i);
  if (candidates.length) await tx.select().from(agentWakeupRequests)
    .where(inArray(agentWakeupRequests.id, candidates.map(w => w.id))).orderBy(asc(agentWakeupRequests.id)).for("update");
}

async function assertPending(tx: DeliveryTx, i: CorrectionDeliveryInput, h: DeliveryHistory, w: DeliveryWake) {
  requireDelivery(w.runId === null && ["queued", "deferred_issue_execution"].includes(w.status)
    && w.claimedAt === null && w.finishedAt === null && w.error === null, "pending");
  await assertDeliveryWake(tx, i, h, w);
  assertDeliverySignature(i, w, false);
  requireDelivery(!(await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.wakeupRequestId, w.id))).length && !(await findDeliveryEvent(tx, i)), "pending");
}
async function waitingState(tx: DeliveryTx, i: CorrectionDeliveryInput,
  h: Awaited<ReturnType<typeof readCurrentQaCorrectionFollowup>>) {
  const { agent, issue } = await assertDeliveryScope(tx, i, h);
  requireDelivery(!["terminated", "pending_approval"].includes(agent.status)
    && issue.status !== "cancelled" && (issue.status !== "done" || h.followup.operation === "recheck") && !issue.hiddenAt
    && !["paused", "completed", "cancelled"].includes(h.database.mission.status)
    && h.database.run.status !== "paused", "not_runnable");
  const block = await budgetService(tx as unknown as Db).getInvocationBlock(i.companyId, i.agentId,
    { issueId: issue.id, projectId: issue.projectId });
  requireDelivery(!block, "budget");
  const policy = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  requireDelivery(i.request.source === "timer" ? asBoolean(policy.enabled, true)
    : asBoolean(policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation, true), "policy");
  const inflight = await lifecycleInFlightClause(tx);
  const activeIssue = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, i.companyId),
    eq(heartbeatRuns.issueId, issue.id), inflight));
  const activeMission = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, i.companyId),
    eq(heartbeatRuns.agentId, i.agentId), inflight, missionDedupExemptOversightReviewClause,
    sql`${heartbeatRuns.contextSnapshot}->>'missionId' = ${i.missionId}`));
  // A stored owner is real even when its context lacks the issue hint; never infer permission from payload.
  const ownerIds = [issue.executionRunId, issue.checkoutRunId].filter((id): id is string => !!id);
  const liveOwner = ownerIds.length ? await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, i.companyId), inArray(heartbeatRuns.id, ownerIds), inflight)) : [];
  return activeIssue.length || liveOwner.length ? "deferred_issue_execution"
    : agent.status === "paused" || activeMission.length ? "queued" : null;
}

function uniqueReceipt(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = error; e && typeof e === "object" && !seen.has(e);) {
    seen.add(e);
    const value = e as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    if (value.code === "23505" && (value.constraint ?? value.constraint_name) === "workflow_transition_events_idempotency_uq") return true;
    e = value.cause;
  }
  return false;
}

/**
 * C02/03/12: own file IO, ordered current authority and one atomic delivery.
 * Callers connect only the supplied TX/wake to an existing promotion writer; they start only startRunId after commit.
 */
export async function withCorrectionDeliveryRoot(db: Db, input: CorrectionDeliveryInput,
  writeLinkedRun: WriteLinkedCorrectionRun, options: CorrectionDeliveryOptions = {}): Promise<CorrectionDeliveryResult> {
  requireDelivery(!is(db, PgTransaction), "root_required");
  const i = structuredClone(input);
  assertDeliveryInput(i);
  const profile = options.transactionProfile;
  const transaction = <T>(work: (tx: DeliveryTx) => Promise<T>, config: Parameters<Db["transaction"]>[1]) => {
    const factory = {
      transaction: <R>(callback: (tx: DeliveryTx) => Promise<R>) => db.transaction(callback, config),
    };
    if (profile === undefined) return factory.transaction(work);
    // The timeout rejects the actual owning callback so Drizzle rolls this transaction back.
    return withTxTimeout<DeliveryTx, T>(factory, async tx => {
      if (profile === "recovery_skip_locked") {
        await tx.execute(sql`SET LOCAL lock_timeout='8s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='30s'`);
      }
      return work(tx);
    }, { timeoutMs: DEFAULT_TX_TIMEOUT_MS, label: "qa-correction-delivery-root" });
  };
  const historical = () => transaction(tx => readQaCorrectionDelivery(tx, i),
    { isolationLevel: "repeatable read", accessMode: "read only" });
  const previous = await historical();
  if (previous) return previous;
  for (let attempt = 0; attempt < 2; attempt++) {
    const o = await observe(db, i);
    try {
      return await transaction<CorrectionDeliveryResult>(async tx => {
        await lockPrefix(tx, i, o);
        const h = await readCurrentQaCorrectionFollowup(tx, i.ref, o.token, readIssuedQaCorrection);
        requireDelivery(h.followup.target.executionGeneration === i.workflowExecutionGeneration, "generation");
        const waiting = await waitingState(tx, i, h), pending = await wakes(tx, i);
        requireDelivery(pending.length <= 1, "duplicate_wake");
        let wake = pending[0];
        if (wake) {
          await assertPending(tx, i, h, wake);
          if (i.candidateWakeupRequestId) requireDelivery(wake.id === i.candidateWakeupRequestId, "candidate");
          if (!same(pending, o.pending)) {
            requireDelivery(i.mode === "initial" && o.pending.length === 0 && attempt === 0, "wake_changed");
            throw new PendingAppeared();
          }
          if (i.mode === "initial" || waiting) return { kind: "waiting" as const, wakeupRequestId: wake.id, startRunId: null };
          requireDelivery(i.mode === (wake.status === "queued" ? "queued" : "deferred"), "mode");
        } else {
          requireDelivery(i.mode === "initial" && !i.candidateWakeupRequestId && o.pending.length === 0, "candidate");
          const r = i.request;
          [wake] = await insertWorkflowWakeRequest(tx as unknown as Db, {
            companyId: i.companyId, agentId: i.agentId, issueId: i.issueId, missionId: i.missionId,
            workflowRunId: i.workflowRunId, workflowStepRunId: i.workflowStepRunId,
            workflowExecutionGeneration: h.followup.target.executionGeneration, source: r.source,
            triggerDetail: r.triggerDetail, reason: waiting === "deferred_issue_execution" ? "issue_execution_deferred" : r.reason,
            requestKind: r.requestKind, requestedByActorType: r.requestedByActorType, requestedByActorId: r.requestedByActorId,
            idempotencyKey: r.idempotencyKey, status: waiting ?? "queued",
            payload: { ...r.payload, issueId: i.issueId, _paperclipWakeContext: r.contextSnapshot },
          });
          requireDelivery(wake, "wake_insert");
          await assertPending(tx, i, h, wake);
          if (waiting) return { kind: "waiting", wakeupRequestId: wake.id, startRunId: null };
        }
        // The callback's return is intentionally ignored: only actual persisted rows can prove the link.
        const beforeWake = structuredClone(wake);
        await writeLinkedRun(tx, wake);
        const linked = await persistDeliveryIdentity(tx, i, h, beforeWake);
        try { return await insertCorrectionDelivery(tx, i, h, linked.wake, linked.heartbeat.id); }
        catch (error) {
          // Classify only errors from THIS receipt insertion; unrelated unique violations still propagate.
          if (uniqueReceipt(error)) throw new ReceiptConflict();
          throw error;
        }
      }, { isolationLevel: "read committed" });
    } catch (error) {
      // transaction() has fully rolled back before any new snapshot or second file observation is opened.
      if (error instanceof ReceiptAppeared || error instanceof ReceiptConflict) {
        const receipt = await historical();
        requireDelivery(receipt, "receipt_missing");
        return receipt;
      }
      if (error instanceof PendingAppeared && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error("qa_correction_delivery_reobserve_exhausted");
}
