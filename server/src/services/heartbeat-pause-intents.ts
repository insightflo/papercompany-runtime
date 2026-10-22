import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, is, or } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions,
  workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { readWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { producerAttempt } from "./work-products/producer-attempt.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, pauseIdentitySchema, pauseScopeInputSchema,
  readPauseControl, type PauseControl, type PauseIdentity, type PauseReceipt, type PauseScopeInput } from "./heartbeat-pause-contract.js";

type Agent = typeof agents.$inferSelect;
type Heartbeat = typeof heartbeatRuns.$inferSelect;
type Scope = Extract<PauseControl, { kind: "scope" }>;
type Head = Extract<PauseControl, { kind: "head" }>;
const reject = (): never => { throw conflict("heartbeat_pause_scope_unproven_or_changed"); };
function transaction(tx: Db) { if (!is(tx, PgTransaction)) reject(); }
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
async function write(tx: Db, value: PauseControl) {
  const p = pauseControlSchema.parse(value), identity = p.kind === "receipt" ? p.identity : null;
  await tx.insert(agentWakeupRequests).values({ ...PAUSE_CONTROL_COLUMNS, id: p.id,
    companyId: p.companyId, agentId: p.agentId, payload: p, runId: null,
    issueId: identity?.issueId ?? null, missionId: identity?.missionId ?? null,
    workflowRunId: identity?.workflow?.runId ?? null, workflowStepRunId: identity?.workflow?.stepRunId ?? null,
    workflowExecutionGeneration: identity?.workflow?.executionGeneration ?? null });
}
async function replace(tx: Db, p: PauseControl) {
  const result = await tx.update(agentWakeupRequests).set({ payload: pauseControlSchema.parse(p), updatedAt: new Date() })
    .where(and(eq(agentWakeupRequests.id, p.id), marker(p.agentId))).returning({ id: agentWakeupRequests.id });
  if (result.length !== 1) reject();
}

/** Caller has already acquired the applicable quality prefix and mission/run/attempt locks.
 * No new earlier-order lock is acquired while reading original admissions below.
 * Historical counters come from the original server proof, never the current step.
 */
async function identityFor(tx: Db, h: Heartbeat, agent: Agent, prior?: PauseIdentity): Promise<PauseIdentity> {
  if (h.companyId !== agent.companyId || h.agentId !== agent.id) return reject();
  const [wake] = h.wakeupRequestId ? await tx.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, h.wakeupRequestId)) : [];
  if (h.wakeupRequestId && (!wake || wake.companyId !== h.companyId || wake.agentId !== h.agentId
    || wake.issueId !== h.issueId || wake.runId !== h.id || wake.status === "coalesced"
    || wake.source === PAUSE_CONTROL_COLUMNS.source)) return reject();
  if (h.issueId) {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, h.issueId));
    if (!issue || issue.companyId !== h.companyId) return reject();
  }
  let workflow: PauseIdentity["workflow"] = null;
  if (h.workflowStepRunId !== null || h.workflowExecutionGeneration !== null || wake?.workflowRunId
    || wake?.workflowStepRunId || wake?.workflowExecutionGeneration != null) {
    if (!wake || (h.workflowStepRunId === null) !== (h.workflowExecutionGeneration === null)) return reject();
    const unclaimed = h.startedAt === null && h.workflowStepRunId === null && (h.status === "queued" || !!prior);
    const stepId = unclaimed ? wake.workflowStepRunId : h.workflowStepRunId;
    const generation = unclaimed ? wake.workflowExecutionGeneration : h.workflowExecutionGeneration;
    if (!stepId || generation === null) return reject();
    const proof = readWorkflowAttemptProof(wake);
    const [step] = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepId));
    const [run] = step ? await tx.select().from(workflowRuns).where(eq(workflowRuns.id, step.workflowRunId)) : [];
    if (!step || !run || run.companyId !== h.companyId || run.id !== proof.workflowRunId
      || step.id !== proof.stepRunId || step.issueId !== h.issueId || run.missionId !== proof.missionId
      || proof.executionGeneration !== generation
      || proof.parentHeartbeatRunId !== h.retryOfRunId) return reject();
    if (!prior) {
      if (step.executionGeneration !== proof.executionGeneration || step.retryCount !== proof.retryCount
        || step.iterationIndex !== proof.iterationIndex) return reject();
      await producerAttempt(tx, { ...h, workflowStepRunId: stepId, workflowExecutionGeneration: generation },
        step, new Set(), h.status === "queued");
    }
    workflow = { workflowId: run.workflowId, runId: run.id, stepRunId: step.id, stepId: step.stepId,
      // This is a pause-time fence, not an invented historical admission version.
      observedAuthorityVersion: prior?.workflow?.observedAuthorityVersion ?? run.dispatchAuthorityVersion,
      executionGeneration: proof.executionGeneration, retryCount: proof.retryCount, iterationIndex: proof.iterationIndex };
  }
  // Unbound requests do not gain a workflow/mission from contextSnapshot or payload hints.
  const missionId = wake?.missionId ?? null;
  if (missionId) {
    const [mission] = await tx.select().from(missions).where(eq(missions.id, missionId));
    if (!mission || mission.companyId !== h.companyId) return reject();
  }
  const value = pauseIdentitySchema.parse({ companyId: h.companyId, agentId: h.agentId,
    heartbeatRunId: h.id, wakeupRequestId: h.wakeupRequestId, issueId: h.issueId, missionId, workflow,
    execution: { scopeKind: h.executionScopeKind, epoch: h.executionEpoch, token: h.executionToken,
      retryOfRunId: h.retryOfRunId, processLossRetryCount: h.processLossRetryCount,
      ownerId: h.executorOwnerId, ownerLeaseEpoch: h.executorOwnerLeaseEpoch, ownerLeaseToken: h.executorOwnerLeaseToken },
    observedPermissions: prior?.observedPermissions ?? agent.permissions });
  if (prior && !isDeepStrictEqual(value, prior)) return reject();
  return value;
}

export type LockedCurrentScope = { agent: Agent; head: Head; scope: Scope | null; receipts: PauseReceipt[] };
/** Agent lock serializes first head creation too; there is no implicit "latest record" fallback. */
export async function lockCurrentScope(tx: Db, agentId: string, expectedScopeId?: string): Promise<LockedCurrentScope> {
  transaction(tx);
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
  if (!agent) return reject();
  const rows = await tx.select().from(agentWakeupRequests).where(marker(agentId)).orderBy(agentWakeupRequests.id).for("update");
  const records = rows.map(readPauseControl);
  if (records.some(p => p.companyId !== agent.companyId)) return reject();
  const heads = records.filter((p): p is Head => p.kind === "head");
  if (heads.length > 1 || (records.length && heads.length !== 1)) return reject();
  let head = heads[0];
  if (!head) {
    if (expectedScopeId !== undefined) return reject();
    head = { schemaVersion: 1, kind: "head", id: randomUUID(), companyId: agent.companyId, agentId, scopeId: null };
    await write(tx, head);
  }
  if (expectedScopeId !== undefined && head.scopeId !== expectedScopeId) return reject();
  const scopes = records.filter((p): p is Scope => p.kind === "scope");
  const receipts = records.filter((p): p is PauseReceipt => p.kind === "receipt");
  const byScope = new Map(scopes.map(p => [p.id, p])), byReceipt = new Map(receipts.map(p => [p.id, p]));
  if ((head.scopeId === null && scopes.length) || (head.scopeId !== null && !byScope.has(head.scopeId))) return reject();
  for (const scope of scopes) {
    const seen = new Set<string>();
    let cursor: Scope | undefined = scope;
    while (cursor) {
      if (seen.has(cursor.id)) return reject();
      seen.add(cursor.id);
      if (cursor.previousScopeId && !byScope.has(cursor.previousScopeId)) return reject();
      cursor = cursor.previousScopeId ? byScope.get(cursor.previousScopeId) : undefined;
    }
    if (scope.receiptIds.some(id => !byReceipt.has(id))) return reject();
  }
  const originals = new Set<string>();
  for (const receipt of receipts) {
    if (originals.has(receipt.identity.heartbeatRunId)) return reject();
    originals.add(receipt.identity.heartbeatRunId);
    if (![receipt.originScopeId, receipt.ownerScopeId, ...(receipt.resumeScopeId ? [receipt.resumeScopeId] : [])]
      .every(id => byScope.get(id)?.receiptIds.includes(receipt.id))) return reject();
    const [original] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.identity.heartbeatRunId));
    if (!original) return reject();
    await identityFor(tx, original, agent, receipt.identity);
    if (receipt.delivery) {
      const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.delivery.wakeupRequestId));
      if (!wake || wake.companyId !== agent.companyId || wake.agentId !== agentId
        || wake.source === PAUSE_CONTROL_COLUMNS.source || wake.issueId !== receipt.identity.issueId
        || wake.missionId !== receipt.identity.missionId || wake.workflowRunId !== (receipt.identity.workflow?.runId ?? null)
        || wake.workflowStepRunId !== (receipt.identity.workflow?.stepRunId ?? null)
        || wake.workflowExecutionGeneration !== (receipt.identity.workflow?.executionGeneration ?? null)) return reject();
      if (receipt.identity.workflow) {
        const proof = readWorkflowAttemptProof(wake), originalAttempt = receipt.identity.workflow;
        if (proof.parentHeartbeatRunId !== original.id || proof.executionGeneration !== originalAttempt.executionGeneration
          || proof.retryCount !== originalAttempt.retryCount || proof.iterationIndex !== originalAttempt.iterationIndex) return reject();
      }
      if (receipt.delivery.heartbeatRunId) {
        const [child] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.delivery.heartbeatRunId));
        if (!child || child.wakeupRequestId !== wake.id || wake.runId !== child.id
          || child.retryOfRunId !== original.id || child.companyId !== agent.companyId || child.agentId !== agentId
          || child.issueId !== original.issueId
          || !((child.workflowStepRunId === (receipt.identity.workflow?.stepRunId ?? null)
            && child.workflowExecutionGeneration === (receipt.identity.workflow?.executionGeneration ?? null))
            || (child.startedAt === null && child.workflowStepRunId === null
              && child.workflowExecutionGeneration === null))) return reject();
      } else if (wake.runId !== null) return reject();
    }
  }
  const scope = head.scopeId ? byScope.get(head.scopeId)! : null;
  const current = scope ? scope.receiptIds.map(id => byReceipt.get(id)!) : [];
  if (current.some(p => p.ownerScopeId !== scope?.id)) return reject();
  return { agent, head, scope, receipts: current };
}

const factsBrand: unique symbol = Symbol("locked pause facts");
export type LockedPauseFacts = { readonly [factsBrand]: true };
type Facts = { tx: Db; input: PauseScopeInput; current: LockedCurrentScope; identities: PauseIdentity[] };
const facts = new WeakMap<LockedPauseFacts, Facts>();
/** Storage-only lock preparation. Callers acquire any applicable C02 quality prefix first.
 * Pre-read only discovers locks. Re-read after them; a new target requires rollback/re-entry.
 */
export async function lockPauseFacts(tx: Db, supplied: PauseScopeInput): Promise<LockedPauseFacts> {
  transaction(tx);
  const input = pauseScopeInputSchema.parse(supplied);
  const preview = (await tx.select().from(agentWakeupRequests).where(marker(input.agentId))).map(readPauseControl);
  const ids = [...new Set([...input.heartbeatRunIds, ...preview.flatMap(p => p.kind === "receipt"
    ? [p.identity.heartbeatRunId, ...(p.delivery?.heartbeatRunId ? [p.delivery.heartbeatRunId] : [])] : [])])].sort();
  const heartbeats = ids.length ? await tx.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids)) : [];
  if (heartbeats.length !== ids.length || heartbeats.some(h => h.companyId !== input.companyId || h.agentId !== input.agentId)) return reject();
  const wakeIds = [...new Set(heartbeats.flatMap(h => h.wakeupRequestId ? [h.wakeupRequestId] : []))];
  const wakes = wakeIds.length ? await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)) : [];
  const runIds = [...new Set(wakes.flatMap(w => w.workflowRunId ? [w.workflowRunId] : []))];
  const runs = runIds.length ? await tx.select().from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  const missionIds = [...new Set([...wakes, ...runs].flatMap(r => r.missionId ? [r.missionId] : []))];
  if (missionIds.length) await tx.select().from(missions).where(inArray(missions.id, missionIds)).orderBy(missions.id).for("no key update");
  if (runIds.length) await tx.select().from(workflowRuns).where(inArray(workflowRuns.id, runIds)).orderBy(workflowRuns.id).for("no key update");
  await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("share");
  const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId)).for("no key update");
  if (!agent || agent.companyId !== input.companyId) return reject();
  if (ids.length) await tx.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids)).orderBy(heartbeatRuns.id).for("update");
  const issueIds = [...new Set(heartbeats.flatMap(h => h.issueId ? [h.issueId] : []))];
  if (issueIds.length) await tx.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(issues.id).for("update");
  const stepIds = [...new Set([...heartbeats, ...wakes].flatMap(h => h.workflowStepRunId ? [h.workflowStepRunId] : []))];
  if (stepIds.length) await tx.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, stepIds)).orderBy(workflowStepRuns.id).for("update");
  if (wakeIds.length) await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)).orderBy(agentWakeupRequests.id).for("update");
  // Earlier lock targets must not have changed while we were waiting for the agent.
  const reread = ids.length ? await tx.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids)) : [];
  const same = (a: Heartbeat, b: Heartbeat) => a.companyId === b.companyId && a.agentId === b.agentId
    && a.issueId === b.issueId && a.wakeupRequestId === b.wakeupRequestId
    && a.workflowStepRunId === b.workflowStepRunId && a.workflowExecutionGeneration === b.workflowExecutionGeneration;
  if (reread.length !== ids.length || reread.some(h => !heartbeats.some(old => old.id === h.id && same(old, h)))) return reject();
  const lockedWakes = wakeIds.length ? await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)) : [];
  if (lockedWakes.length !== wakes.length || lockedWakes.some(w => !wakes.some(old => old.id === w.id
    && old.companyId === w.companyId && old.agentId === w.agentId && old.issueId === w.issueId
    && old.missionId === w.missionId && old.workflowRunId === w.workflowRunId
    && old.workflowStepRunId === w.workflowStepRunId && old.workflowExecutionGeneration === w.workflowExecutionGeneration))) return reject();
  const lockedRuns = runIds.length ? await tx.select().from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  if (lockedRuns.length !== runs.length || lockedRuns.some(r => !runs.some(old => old.id === r.id
    && old.companyId === r.companyId && old.missionId === r.missionId))) return reject();
  const current = await lockCurrentScope(tx, input.agentId, input.expectedScopeId);
  if (current.receipts.some(p => !ids.includes(p.identity.heartbeatRunId)
    || (p.delivery?.heartbeatRunId && !ids.includes(p.delivery.heartbeatRunId)))) return reject();
  const identities: PauseIdentity[] = [];
  for (const id of input.heartbeatRunIds) {
    const [h] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    if (!h) return reject();
    const prior = current.receipts.find(p => p.identity.heartbeatRunId === id);
    if (!prior && !["running", "queued"].includes(h.status)) return reject();
    identities.push(await identityFor(tx, h, agent, prior?.identity));
  }
  const handle: LockedPauseFacts = Object.freeze({ [factsBrand]: true as const });
  facts.set(handle, { tx, input, current, identities });
  return handle;
}

/** The outer transaction owns agent status/cancellation. This savepoint keeps storage atomic
 * even if a caller catches a write failure; this function never signals or starts execution.
 */
export async function recordPauseScope(tx: Db, lockedFacts: LockedPauseFacts): Promise<LockedCurrentScope> {
  transaction(tx);
  const captured = facts.get(lockedFacts);
  if (!captured || captured.tx !== tx) return reject();
  facts.delete(lockedFacts);
  const current = await lockCurrentScope(tx, captured.input.agentId);
  if (current.head.id !== captured.current.head.id || current.head.scopeId !== captured.current.head.scopeId) return reject();
  return tx.transaction(async inner => {
    const t = inner as unknown as Db, input = captured.input, scopeId = randomUUID();
    const inherited = current.receipts.filter(p => p.delivery === null);
    const fresh: PauseReceipt[] = [];
    for (const identity of captured.identities) {
      if (inherited.some(p => p.identity.heartbeatRunId === identity.heartbeatRunId)) continue;
      if (current.receipts.some(p => p.identity.heartbeatRunId === identity.heartbeatRunId)) return reject();
      fresh.push({ schemaVersion: 1, kind: "receipt", id: randomUUID(), companyId: input.companyId,
        agentId: input.agentId, originScopeId: scopeId, ownerScopeId: scopeId, cause: input.cause, identity,
        resumeScopeId: null, stopped: null, delivery: null, invalidated: input.cause === "manual_pause"
          ? null : { cause: input.cause, at: new Date().toISOString() } });
    }
    const scope: Scope = { schemaVersion: 1, kind: "scope", id: scopeId, companyId: input.companyId, agentId: input.agentId,
      previousScopeId: current.head.scopeId, cause: input.cause, receiptIds: [...inherited, ...fresh].map(p => p.id).sort(),
      observedAgent: { status: current.agent.status, pausedAt: current.agent.pausedAt?.toISOString() ?? null,
        permissions: current.agent.permissions } };
    await write(t, scope);
    for (const p of fresh) await write(t, p);
    for (const p of inherited) await replace(t, { ...p, ownerScopeId: scopeId,
      invalidated: p.invalidated ?? (input.cause === "manual_pause" ? null : { cause: input.cause, at: new Date().toISOString() }) });
    // Old resumeScopeId and delivered links remain history, never authorization for this new scope.
    await replace(t, { ...current.head, scopeId });
    return lockCurrentScope(t, input.agentId, scopeId);
  });
}
