import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { and, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl, type PauseReceipt } from "./heartbeat-pause-contract.js";
import { readWorkflowAttemptProof, WORKFLOW_ATTEMPT_PROOF_KEY, workflowAttemptProofSchema } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { lifecycleInFlightClause } from "./heartbeat-finalization/lifecycle-active.js";
import { resolveNextDispatchGeneration } from "./effect-envelope.js";
import { deriveTaskKey, normalizeAgentNameKey } from "./heartbeat-run-context.js";
import { readWorkflowRetryMetadata } from "./workflow/retry-policy.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;
type Reader = Pick<Db, "select">;
const reject = (): never => { throw conflict("heartbeat_pause_delivery_unproven_or_changed"); };
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));

export async function readPauseControls(db: Reader, agentId: string) {
  const records = (await db.select().from(agentWakeupRequests).where(marker(agentId))
    .orderBy(agentWakeupRequests.id)).map(readPauseControl);
  const heads = records.filter(p => p.kind === "head"), scopes = records.filter(p => p.kind === "scope");
  if (records.length && (heads.length !== 1 || (heads[0]!.scopeId === null
    ? scopes.length !== 0 : !scopes.some(p => p.id === heads[0]!.scopeId)))) return reject();
  for (const scope of scopes) {
    const seen = new Set<string>();
    let cursor: typeof scope | undefined = scope;
    while (cursor) {
      if (seen.has(cursor.id)) return reject();
      seen.add(cursor.id);
      const previous: string | null = cursor.previousScopeId;
      cursor = previous ? scopes.find(p => p.id === previous) : undefined;
      if (previous && !cursor) return reject();
    }
  }
  if (scopes.some(s => s.receiptIds.some(id => !records.some(p => p.kind === "receipt" && p.id === id)))) return reject();
  const current = scopes.find(s => s.id === heads[0]?.scopeId);
  if (current?.receiptIds.some(id => !records.some(p => p.kind === "receipt" && p.id === id
    && p.ownerScopeId === current.id))) return reject();
  const originals = new Set<string>();
  for (const p of records) {
    if (p.kind !== "receipt") continue;
    if (originals.has(p.identity.heartbeatRunId)) return reject();
    originals.add(p.identity.heartbeatRunId);
    if (![p.originScopeId, p.ownerScopeId, ...(p.resumeScopeId ? [p.resumeScopeId] : [])]
      .every(id => scopes.some(s => s.id === id && s.receiptIds.includes(p.id)))) return reject();
  }
  return records;
}
/** SELECT-only hints for the existing queue, never approval or proof of current scope.
 * Delivery re-reads the exact receipt under its established admission/control locks.
 */
export async function selectPauseResumeCandidates(db: Reader, agentId?: string) {
  return db.select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId })
    .from(agentWakeupRequests).where(and(
      agentId ? eq(agentWakeupRequests.agentId, agentId) : undefined,
      eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
      eq(agentWakeupRequests.requestedByActorType, PAUSE_CONTROL_COLUMNS.requestedByActorType),
      eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId),
      eq(agentWakeupRequests.requestKind, PAUSE_CONTROL_COLUMNS.requestKind),
      eq(agentWakeupRequests.status, PAUSE_CONTROL_COLUMNS.status),
      sql`${agentWakeupRequests.runId} is null`,
      sql`${agentWakeupRequests.payload} ->> 'kind' = 'receipt'`,
      sql`${agentWakeupRequests.payload} ->> 'cause' = 'manual_pause'`,
      sql`${agentWakeupRequests.payload} ->> 'resumeScopeId' = ${agentWakeupRequests.payload} ->> 'ownerScopeId'`,
      sql`${agentWakeupRequests.payload} -> 'stopped' <> 'null'::jsonb`,
      sql`${agentWakeupRequests.payload} -> 'invalidated' = 'null'::jsonb`,
      sql`${agentWakeupRequests.payload} -> 'delivery' = 'null'::jsonb`,
    )).orderBy(agentWakeupRequests.requestedAt, agentWakeupRequests.id);
}
export function pauseExecutionIdentity(h: Run) {
  return { scopeKind: h.executionScopeKind, epoch: h.executionEpoch, token: h.executionToken,
    retryOfRunId: h.retryOfRunId, processLossRetryCount: h.processLossRetryCount,
    ownerId: h.executorOwnerId, ownerLeaseEpoch: h.executorOwnerLeaseEpoch, ownerLeaseToken: h.executorOwnerLeaseToken };
}
export function pauseLinked(h: Run, w: Wake) {
  const typed = (h.workflowStepRunId === w.workflowStepRunId && h.workflowExecutionGeneration === w.workflowExecutionGeneration)
    || (!h.startedAt && h.workflowStepRunId === null && h.workflowExecutionGeneration === null);
  return w.companyId === h.companyId && w.agentId === h.agentId && w.issueId === h.issueId
    && h.wakeupRequestId === w.id && w.runId === h.id && w.status !== "coalesced" && typed;
}

/** SELECT-only ancestry, never execution permission. Historical scopes may have been superseded. */
export async function readStoppedPauseOriginal(db: Reader, receipt: PauseReceipt) {
  const records = await readPauseControls(db, receipt.agentId), i = receipt.identity, f = i.workflow;
  const stored = records.find(p => p.id === receipt.id);
  const origin = records.find(p => p.kind === "scope" && p.id === receipt.originScopeId);
  const owner = records.find(p => p.kind === "scope" && p.id === receipt.ownerScopeId);
  if (!same(stored, receipt) || records.some(p => p.companyId !== i.companyId)
    || receipt.cause !== "manual_pause" || origin?.kind !== "scope" || owner?.kind !== "scope"
    || origin.cause !== "manual_pause" || owner.cause !== "manual_pause"
    || receipt.resumeScopeId !== owner.id || !receipt.stopped) return reject();
  const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, i.heartbeatRunId));
  const [originalWake] = i.wakeupRequestId ? await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, i.wakeupRequestId)) : [];
  if (!parent || !originalWake || !pauseLinked(parent, originalWake) || parent.companyId !== i.companyId
    || parent.agentId !== i.agentId || parent.issueId !== i.issueId || !same(pauseExecutionIdentity(parent), i.execution)
    || !["cancelled", "failed", "succeeded", "timed_out"].includes(parent.status)
    || originalWake.source === PAUSE_CONTROL_COLUMNS.source || originalWake.missionId !== i.missionId
    || originalWake.workflowRunId !== (f?.runId ?? null) || originalWake.workflowStepRunId !== (f?.stepRunId ?? null)
    || originalWake.workflowExecutionGeneration !== (f?.executionGeneration ?? null)) return reject();
  if (f) {
    const p = readWorkflowAttemptProof(originalWake);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    if (!step || !run || run.companyId !== i.companyId || run.workflowId !== f.workflowId
      || run.missionId !== i.missionId || step.workflowRunId !== f.runId || step.stepId !== f.stepId
      || step.issueId !== i.issueId || p.executionGeneration !== f.executionGeneration
      || p.retryCount !== f.retryCount || p.iterationIndex !== f.iterationIndex
      || p.parentHeartbeatRunId !== i.execution.retryOfRunId) return reject();
  }
  return { receipt, parent, originalWake, records };
}
export type PauseDeliveryOriginal = Awaited<ReturnType<typeof readStoppedPauseOriginal>>;

/** IDs select persisted authority; caller-supplied objects cannot authorize a never-started parent. */
export async function readPauseDeliveryOriginal(db: Reader, receiptId: string) {
  const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId));
  if (!row) return reject();
  const receipt = readPauseControl(row);
  if (receipt.kind !== "receipt") return reject();
  const original = await readStoppedPauseOriginal(db, receipt);
  const heads = original.records.filter(p => p.kind === "head");
  if (heads.length !== 1 || heads[0]!.scopeId !== receipt.ownerScopeId || receipt.invalidated) return reject();
  return original;
}

/** Only a concurrent delivery winner permits one fresh root observation; changed approval never does. */
export class PauseDeliveryReobserve extends Error {}
export function comparePauseDelivery(original: PauseDeliveryOriginal, fresh: PauseDeliveryOriginal) {
  if (!same({ ...original.receipt, delivery: null }, { ...fresh.receipt, delivery: null })
    || !same(original.records.filter(p => p.kind !== "receipt"), fresh.records.filter(p => p.kind !== "receipt"))) return reject();
  if (!same(original.receipt.delivery, fresh.receipt.delivery)) throw new PauseDeliveryReobserve();
}

/** Owns a real root. All old-row locks precede head/scope/receipt; writes below use that exact set. */
export async function deliverPauseResume(db: Db, receiptId: string): Promise<Run | null> {
  if (is(db, PgTransaction)) throw conflict("heartbeat_pause_delivery_root_required");
  const admission = await import("./heartbeat-pause-admission.js");
  const roots = await import("./workflow/control-flow/qa-correction-claim-root.js");
  const { assertHeartbeatRecoveryAdmission } = await import("./heartbeat-recovery-guard.js");
  const attempt = async () => {
    const observed = await admission.observePauseDeliveryAdmission(db, receiptId);
    const run = admission.pauseDeliveryRun(observed);
    let prepared: Awaited<ReturnType<typeof admission.preparePauseDeliveryAdmission>> | undefined;
    let dispatchGeneration = 0;
    const result = await roots.withPausedQaCorrectionDeliveryRoot(db, observed, async t => {
      prepared = await admission.preparePauseDeliveryAdmission(t, observed, missionId =>
        assertHeartbeatRecoveryAdmission(t, { ...run, missionId }));
    }, async t => {
      if (!prepared) return reject();
      const current = await admission.assertCurrentPauseDelivery(t, observed, prepared, async () => {
        // Existing issue -> dispatch advisory order, still before head/scope/receipt.
        dispatchGeneration = await resolveNextDispatchGeneration(t, { agentId: run.agentId,
          issueId: run.issueId, taskKey: deriveTaskKey(parseObject(run.contextSnapshot), null) });
      });
      const { receipt, parent } = current, i = receipt.identity, f = i.workflow;
      if (receipt.delivery) {
        const [child] = await t.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.delivery.heartbeatRunId!));
        if (!child) return reject();
        return child;
      }
      if (new Date(receipt.stopped!.observedAt) > new Date()) return reject();
      if (f) {
        const [step] = await t.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
        if (!step || step.status === "cancelled") return reject();
        const raw = parseObject(step.metadata).workflowRetry, retry = readWorkflowRetryMetadata(raw);
        // Waiting belongs to the existing retry dispatcher, including a due-but-unclaimed retry.
        if (raw !== undefined && raw !== null && (!retry || retry.state === "waiting")) return null;
        if (retry && (retry.retryNumber !== f.retryCount || new Date(retry.nextEligibleAt) > new Date())) return null;
      }
      const pending = await t.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, i.companyId),
        eq(agentWakeupRequests.agentId, i.agentId), inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
        or(i.issueId ? eq(agentWakeupRequests.issueId, i.issueId) : undefined,
          f ? eq(agentWakeupRequests.workflowStepRunId, f.stepRunId) : undefined)));
      const ancestors = admission.pauseDeliveryAncestors(prepared);
      if (pending.some(w => !w.runId || !ancestors.includes(w.runId))) return null;
      // Queue/mission dedup remains admission, not an idempotency-string substitute.
      const others = await t.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, i.companyId),
        eq(heartbeatRuns.agentId, i.agentId), await lifecycleInFlightClause(t),
        or(i.issueId ? eq(heartbeatRuns.issueId, i.issueId) : undefined,
          f ? eq(heartbeatRuns.workflowStepRunId, f.stepRunId) : undefined,
          i.missionId ? sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${i.missionId}` : undefined)));
      if (others.some(h => h.id !== parent.id)) return reject();
      const [agent] = await t.select().from(agents).where(eq(agents.id, i.agentId));
      if (!agent) return reject();
      const now = new Date(), wakeId = randomUUID(), childId = randomUUID();
      const proof = f ? workflowAttemptProofSchema.parse({ ...readWorkflowAttemptProof(current.originalWake),
        wakeupRequestId: wakeId, parentHeartbeatRunId: parent.id }) : null;
      const context = { ...parseObject(parent.contextSnapshot), issueId: i.issueId,
        missionId: i.missionId, workflowRunId: f?.runId ?? null, workflowStepRunId: f?.stepRunId ?? null,
        ...(f ? { workflowStepId: f.stepId, stepId: f.stepId } : {}),
        retryOfRunId: parent.id, wakeReason: "agent_pause_resume", wakeSource: "automation",
        wakeTriggerDetail: "system", dispatchGeneration };
      await t.insert(agentWakeupRequests).values({ id: wakeId, companyId: i.companyId, agentId: i.agentId,
        issueId: i.issueId, missionId: i.missionId, workflowRunId: f?.runId ?? null,
        workflowStepRunId: f?.stepRunId ?? null, workflowExecutionGeneration: f?.executionGeneration ?? null,
        source: "automation", triggerDetail: "system", requestKind: "agent_pause_resume", reason: "agent_pause_resume",
        status: "queued", requestedByActorType: "system", requestedByActorId: null, idempotencyKey: null,
        requestedAt: now, payload: proof ? { [WORKFLOW_ATTEMPT_PROOF_KEY]: proof } : null });
      const [child] = await t.insert(heartbeatRuns).values({ id: childId, companyId: i.companyId, agentId: i.agentId,
        issueId: i.issueId, invocationSource: "automation", triggerDetail: "system", status: "queued",
        wakeupRequestId: wakeId, retryOfRunId: parent.id, processLossRetryCount: i.execution.processLossRetryCount,
        contextSnapshot: context, sessionIdBefore: parent.sessionIdAfter ?? parent.sessionIdBefore }).returning();
      if (!child) return reject();
      await t.update(agentWakeupRequests).set({ runId: child.id, updatedAt: now }).where(eq(agentWakeupRequests.id, wakeId));
      if (i.issueId) {
        const [issue] = await t.select().from(issues).where(eq(issues.id, i.issueId));
        if (!issue) return reject();
        if ([issue.executionRunId, issue.checkoutRunId].some(id => id && !ancestors.includes(id))) return reject();
        await t.update(issues).set({ executionRunId: child.id,
          checkoutRunId: issue.checkoutRunId ? child.id : null,
          executionAgentNameKey: normalizeAgentNameKey(agent.name), executionLockedAt: now, updatedAt: now })
          .where(and(eq(issues.id, i.issueId), eq(issues.companyId, i.companyId)));
      }
      const payload = pauseControlSchema.parse({ ...receipt, delivery: { wakeupRequestId: wakeId, heartbeatRunId: child.id } });
      const [saved] = await t.update(agentWakeupRequests).set({ payload, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, receipt.id), marker(i.agentId))).returning();
      if (!saved || !same(readPauseControl(saved), payload)) return reject();
      return child;
    });
    return result.kind === "performed" ? result.value : null;
  };
  try { return await attempt(); }
  catch (error) {
    const cause = error instanceof roots.QaCorrectionClaimRejected ? error.cause : error;
    if (!(cause instanceof PauseDeliveryReobserve)) throw error;
    // Rollback is complete before observing the winner's actual child/locks. No retry on changed authority.
    return attempt();
  }
}
