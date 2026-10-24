import { isDeepStrictEqual as same } from "node:util";
import { and, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, issueWorkProducts, missions,
  qualityActions, workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import type { BudgetEnforcementScope } from "./budgets.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl, type PauseReceipt } from "./heartbeat-pause-contract.js";
import { lockCurrentScope } from "./heartbeat-pause-intents.js";
import { readPauseControls } from "./heartbeat-pause-delivery.js";
import { readPauseChildProof } from "./heartbeat-pause-admission.js";
import { parseQualityWakeKey } from "./quality/native-wake.js";
import { lockQualityAttemptBudget, readQualityStepActionId } from "./quality/retry-budget.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";
import { readIssuedQaCorrectionFollowupForAttempt, type IssuedQaCorrection } from "./workflow/control-flow/qa-correction-reader.js";
import { createQaCorrectionHistorySession } from "./workflow/control-flow/qa-correction-history-session.js";

type Run = typeof heartbeatRuns.$inferSelect;
export type PauseInvalidationTarget = { kind: "run"; id: string } | { kind: "agent"; id: string }
  | { kind: "budget"; scope: BudgetEnforcementScope };
export type PauseInvalidationCause = "user_cancel" | "budget";
type StatusWriter = (tx: Db, id: string, status: string, patch: Partial<typeof heartbeatRuns.$inferInsert>,
  options: { expectedStatuses: string[]; deferLiveEvent: boolean }) => Promise<Run | null>;
const reject = (): never => { throw conflict("heartbeat_pause_invalidation_scope_changed"); };
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const active = (h: Run) => h.status === "queued" || h.status === "running";
const runIdentity = (h: Run) => [h.id, h.companyId, h.agentId, h.issueId, h.wakeupRequestId,
  h.workflowStepRunId, h.workflowExecutionGeneration, h.retryOfRunId, h.contextSnapshot];
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));

/** Revocation grants no admission. Saved receipts and exact delivery links alone select descendants;
 * expired permission/generation never becomes permission to start, or a reason to retain old intent.
 */
async function observe(db: Db, target: PauseInvalidationTarget) {
  const [requested] = target.kind === "run" ? await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, target.id)) : [];
  if (target.kind === "run" && !requested) throw notFound("Heartbeat run not found");
  const agentId = target.kind === "run" ? requested!.agentId : target.kind === "agent" ? target.id
    : target.scope.scopeType === "agent" ? target.scope.scopeId : null;
  const selectedAgents = await db.select().from(agents).where(agentId ? eq(agents.id, agentId)
    : eq(agents.companyId, target.kind === "budget" ? target.scope.companyId : reject())).orderBy(agents.id);
  const companyId = target.kind === "budget" ? target.scope.companyId : requested?.companyId ?? selectedAgents[0]?.companyId;
  if (selectedAgents.some(a => a.companyId !== companyId)) return reject();
  const records = (await Promise.all(selectedAgents.map(a => readPauseControls(db, a.id)))).flat();
  const receipts = records.filter((p): p is PauseReceipt => p.kind === "receipt");
  const membership = and(eq(heartbeatRuns.companyId, companyId ?? "00000000-0000-0000-0000-000000000000"),
    agentId ? eq(heartbeatRuns.agentId, agentId) : undefined);
  const scoped = async (ids?: string[]) => db.select({ run: heartbeatRuns }).from(heartbeatRuns).leftJoin(issues, and(
    eq(issues.companyId, heartbeatRuns.companyId),
    sql`${issues.id}::text = coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId')`))
    .where(and(membership, ids ? inArray(heartbeatRuns.id, ids) : inArray(heartbeatRuns.status, ["queued", "running"]),
      target.kind === "budget" && target.scope.scopeType === "project"
        ? sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text) = ${target.scope.scopeId}` : undefined))
    .orderBy(heartbeatRuns.id).then(rows => rows.map(r => r.run));
  const candidates = target.kind === "run" ? [requested!] : await scoped();
  const selected = new Set(candidates.map(h => h.id));
  const receiptRunIds = sorted(receipts.flatMap(p => [p.identity.heartbeatRunId,
    ...(p.delivery?.heartbeatRunId ? [p.delivery.heartbeatRunId] : [])]));
  if (target.kind !== "run") for (const h of receiptRunIds.length ? await scoped(receiptRunIds) : []) selected.add(h.id);
  const chosen = new Set<string>();
  for (;;) {
    const before = chosen.size;
    for (const p of receipts) {
      if (!selected.has(p.identity.heartbeatRunId) && !(p.delivery?.heartbeatRunId && selected.has(p.delivery.heartbeatRunId))) continue;
      chosen.add(p.id); selected.add(p.identity.heartbeatRunId);
      if (p.delivery?.heartbeatRunId) selected.add(p.delivery.heartbeatRunId);
    }
    if (chosen.size === before) break;
  }
  const pending = target.kind === "budget" ? await db.select({ wake: agentWakeupRequests }).from(agentWakeupRequests)
    .leftJoin(issues, and(eq(issues.companyId, target.scope.companyId),
      sql`${issues.id}::text = ${agentWakeupRequests.payload} ->> 'issueId'`))
    .where(and(eq(agentWakeupRequests.companyId, target.scope.companyId),
      agentId ? eq(agentWakeupRequests.agentId, agentId) : undefined,
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
      sql`${agentWakeupRequests.runId} is null`, target.scope.scopeType === "project"
        ? sql`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text) = ${target.scope.scopeId}` : undefined))
    .orderBy(agentWakeupRequests.id).then(rows => rows.map(r => r.wake)) : [];
  const all = new Map(candidates.map(h => [h.id, h]));
  for (const id of sorted([...receiptRunIds, ...selected])) {
    if (all.has(id)) continue;
    const [h] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    if (!h || h.companyId !== companyId) return reject();
    all.set(h.id, h);
  }
  const histories = new Map<string, IssuedQaCorrection>(), wakes = new Map<string, typeof agentWakeupRequests.$inferSelect>();
  for (const h of all.values()) {
    if (h.retryOfRunId && !all.has(h.retryOfRunId)) {
      const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, h.retryOfRunId));
      if (!parent || parent.companyId !== companyId || parent.agentId !== h.agentId) return reject();
      all.set(parent.id, parent);
    }
    if (!h.wakeupRequestId) continue;
    const [w] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, h.wakeupRequestId));
    if (!w || w.companyId !== h.companyId || w.agentId !== h.agentId || w.runId !== h.id) return reject();
    wakes.set(w.id, w);
    const ref = readQaCorrectionWakeRef(w);
    if (ref) {
      const history = await readIssuedQaCorrectionFollowupForAttempt(db, ref);
      histories.set(ref.appliedEventId, history.issued);
    }
  }
  // Reuse real issuance history, including prior corrections, for its existing lock dependencies.
  for (const [appliedEventId, issued] of histories) {
    const p = issued.preparation, readIssued = createQaCorrectionHistorySession(db, {
      companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId });
    for (const source of p.sources) {
      if (source.provenance.kind !== "prior_correction") continue;
      const prior = await readIssued(db, { companyId: p.companyId, workflowRunId: p.workflowRunId,
        appliedEventId: source.provenance.appliedEventId });
      histories.set(source.provenance.appliedEventId, prior);
    }
  }
  const history = [...histories.values()], preparations = history.map(h => h.preparation);
  const targets = history.flatMap(h => [...h.followups.map(f => f.target), h.preparation.producer,
    ...h.preparation.authority.verdicts.map(v => v.qa), ...h.preparation.bindings.map(b => b.consumer)]);
  const issueIds = sorted([...all.values()].flatMap(h => h.issueId ? [h.issueId] : []).concat(targets.map(t => t.issueId)));
  const issueRows = issueIds.length ? await db.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(issues.id) : [];
  const stepIds = sorted([...all.values(), ...wakes.values()].flatMap(h => h.workflowStepRunId ? [h.workflowStepRunId] : [])
    .concat(targets.map(t => t.stepRunId)));
  const steps = stepIds.length ? await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, stepIds)) : [];
  const runIds = sorted([...wakes.values()].flatMap(w => w.workflowRunId ? [w.workflowRunId] : [])
    .concat(steps.map(s => s.workflowRunId), preparations.map(p => p.workflowRunId),
      issueRows.flatMap(i => i.originKind === "workflow_execution" && i.originRunId ? [i.originRunId] : [])));
  const workflows = runIds.length ? await db.select().from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  if (workflows.some(w => w.companyId !== companyId) || issueRows.some(i => i.companyId !== companyId)) return reject();
  const actionIds = sorted([...steps.flatMap(s => { const id = readQualityStepActionId(s.metadata); return id ? [id] : []; }),
    ...[...wakes.values()].flatMap(w => { const key = parseQualityWakeKey(w.idempotencyKey); return key ? [key.actionId] : []; }),
    ...preparations.flatMap(p => p.authority.kind === "quality_current_output" ? [p.authority.actionId] : [])]);
  const actions = actionIds.length ? await db.select({ id: qualityActions.id, companyId: qualityActions.companyId,
    groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId }).from(qualityActions)
    .where(inArray(qualityActions.id, actionIds)).orderBy(qualityActions.policyVersionId, qualityActions.groupId, qualityActions.id) : [];
  if (actions.length !== actionIds.length || actions.some(a => a.companyId !== companyId)) return reject();
  const heartbeatIds = sorted([...all.keys(), ...preparations.flatMap(p => [
    ...p.authority.verdicts.map(v => v.heartbeatRunId),
    ...p.sources.flatMap(s => s.provenance.kind === "workflow_producer" ? [s.provenance.workflowProducer.heartbeatRunId] : []),
    ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : [])]),
    ...issueRows.flatMap(i => [i.executionRunId, i.checkoutRunId].filter((id): id is string => !!id))]);
  const products = sorted(history.flatMap(h => [...h.preparation.sources.map(s => s.productId), ...h.applied.revisions.map(r => r.workProductId)]));
  const bindings = sorted(preparations.flatMap(p => p.bindings.map(b => b.bindingId)));
  const missionIds = sorted([...records.flatMap(p => p.kind === "receipt" && p.identity.missionId ? [p.identity.missionId] : []),
    ...workflows.flatMap(w => w.missionId ? [w.missionId] : []), ...[...wakes.values()].flatMap(w => w.missionId ? [w.missionId] : [])]);
  return { requested, companyId, selectedAgents, records, receipts, chosen: sorted([...chosen]),
    targets: [...all.values()].filter(h => selected.has(h.id) && active(h)).sort((a, b) => a.id.localeCompare(b.id)),
    pending, all: [...all.values()].sort((a, b) => a.id.localeCompare(b.id)), wakes: [...wakes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    actions, heartbeatIds, issueIds, stepIds, runIds, missionIds, products, bindings, issueRows, workflows };
}
type Observation = Awaited<ReturnType<typeof observe>>;
function footprint(o: Observation) {
  return { companyId: o.companyId, agents: o.selectedAgents.map(a => [a.id, a.companyId]),
    records: o.records, chosen: o.chosen, targets: o.targets.map(runIdentity), all: o.all.map(runIdentity),
    wakes: o.wakes, pending: o.pending, actions: o.actions, heartbeatIds: o.heartbeatIds, issueIds: o.issueIds,
    stepIds: o.stepIds, runIds: o.runIds, missionIds: o.missionIds, products: o.products, bindings: o.bindings,
    owners: o.issueRows.map(i => [i.id, i.companyId, i.projectId, i.executionRunId, i.checkoutRunId]),
    workflows: o.workflows.map(w => [w.id, w.companyId, w.missionId]) };
}

/** Own the actual commit: a savepoint cannot authorize signals or queue progress. */
export async function commitPauseInvalidation(db: Db, target: PauseInvalidationTarget,
  cause: PauseInvalidationCause, reason: string, setStatus: StatusWriter) {
  if (is(db, PgTransaction)) throw conflict("heartbeat_cancellation_root_required");
  return db.transaction(async tx => {
    const t = tx as unknown as Db, o = await observe(t, target);
    if (!o.targets.length && !o.pending.length && !o.chosen.length) return { changed: [], requested: o.requested };
    for (const action of o.actions) await lockQualityAttemptBudget(tx, { companyId: action.companyId, actionId: action.id, now: new Date() });
    if (o.missionIds.length) await t.select().from(missions).where(inArray(missions.id, o.missionIds)).orderBy(missions.id).for("no key update");
    if (o.runIds.length) await t.select().from(workflowRuns).where(inArray(workflowRuns.id, o.runIds)).orderBy(workflowRuns.id).for("no key update");
    if (o.companyId) await t.select().from(companies).where(eq(companies.id, o.companyId)).for("share");
    if (o.selectedAgents.length) await t.select().from(agents).where(inArray(agents.id, o.selectedAgents.map(a => a.id))).orderBy(agents.id).for("no key update");
    if (o.heartbeatIds.length) await t.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, o.heartbeatIds)).orderBy(heartbeatRuns.id).for("update");
    if (o.issueIds.length) await t.select().from(issues).where(inArray(issues.id, o.issueIds)).orderBy(issues.id).for("update");
    if (o.stepIds.length) await t.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, o.stepIds)).orderBy(workflowStepRuns.id).for("update");
    if (o.products.length) await t.select().from(issueWorkProducts).where(inArray(issueWorkProducts.id, o.products)).orderBy(issueWorkProducts.id).for("update");
    if (o.bindings.length) await t.select().from(workflowStepOutputBindings).where(inArray(workflowStepOutputBindings.id, o.bindings)).orderBy(workflowStepOutputBindings.id).for("update");
    const wakeIds = sorted([...o.wakes.map(w => w.id), ...o.pending.map(w => w.id)]);
    if (wakeIds.length) await t.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)).orderBy(agentWakeupRequests.id).for("update");
    for (const kind of ["head", "scope", "receipt"] as const) {
      const ids = o.records.filter(p => p.kind === kind).map(p => p.id).sort();
      if (ids.length) await t.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, ids)).orderBy(agentWakeupRequests.id).for("update");
    }
    const fresh = await observe(t, target);
    if (!same(footprint(o), footprint(fresh))) return reject();
    for (const a of fresh.selectedAgents) {
      if (fresh.records.some(p => p.agentId === a.id)) await lockCurrentScope(t, a.id);
    }
    const now = new Date();
    for (const p of fresh.receipts.filter(p => fresh.chosen.includes(p.id))) {
      if (p.delivery?.heartbeatRunId) {
        const child = fresh.all.find(h => h.id === p.delivery!.heartbeatRunId);
        if (!child || (await readPauseChildProof(t, child, true))?.receipt.id !== p.id) return reject();
      }
      if (p.invalidated) continue;
      const payload = pauseControlSchema.parse({ ...p, invalidated: { cause, at: now.toISOString() } });
      const [saved] = await t.update(agentWakeupRequests).set({ payload, updatedAt: now }).where(and(
        eq(agentWakeupRequests.id, p.id), marker(p.agentId))).returning();
      if (!saved || !same(readPauseControl(saved), payload)) return reject();
    }
    const changed: { original: Run; cancelled: Run }[] = [];
    for (const original of fresh.targets) {
      const cancelled = await setStatus(t, original.id, "cancelled", { finishedAt: now, error: reason, errorCode: "cancelled" },
        { expectedStatuses: [original.status], deferLiveEvent: true });
      if (!cancelled) return reject();
      if (original.wakeupRequestId) {
        const [wake] = await t.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, error: reason, updatedAt: now })
          .where(and(eq(agentWakeupRequests.id, original.wakeupRequestId), eq(agentWakeupRequests.runId, original.id),
            eq(agentWakeupRequests.companyId, original.companyId), eq(agentWakeupRequests.agentId, original.agentId))).returning();
        if (!wake) return reject();
      }
      changed.push({ original, cancelled });
    }
    for (const pending of fresh.pending) {
      const [wake] = await t.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, error: reason, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, pending.id), sql`${agentWakeupRequests.runId} is null`,
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]))).returning();
      if (!wake) return reject();
    }
    await t.execute(sql`select 1`);
    return { changed, requested: fresh.requested };
  });
}
