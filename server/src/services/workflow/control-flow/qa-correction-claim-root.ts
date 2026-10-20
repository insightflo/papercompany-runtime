import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, inArray, is, or } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts,
  workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { conflict } from "../../../errors.js";
import { asBoolean, parseObject } from "../../../adapters/utils.js";
import { isQaCorrectionRootOwnerRequired, registerQaCorrectionRootDrain } from "../../issue-assignment-wakeup.js";
import { lockQualityAttemptBudget } from "../../quality/retry-budget.js";
import { producerAttempt } from "../../work-products/producer-attempt.js";
import { readQaCorrectionWakeRef } from "../../work-products/qa-correction-producer-attempt.js";
import { readIssuedQaCorrection, readIssuedQaCorrectionFollowupForAttempt, type IssuedQaCorrection } from "./qa-correction-reader.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup,
  readQaCorrectionFollowupDb } from "./qa-correction-followup.js";
import type { DeliveryHistory, DeliveryTx, DeliveryWake } from "./qa-correction-delivery-receipt.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Connection = Pick<Db, "select">;
type Boundary<T> = { kind: "performed"; value: T } | { kind: "root_deferred" } | { kind: "not_claimed" };
const requireClaim = (ok: unknown) => {
  if (!ok) throw conflict("qa_correction_claim_relation_changed");
};
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const identity = (r: Run) => [r.id, r.companyId, r.agentId, r.issueId, r.wakeupRequestId,
  r.retryOfRunId, r.workflowStepRunId, r.workflowExecutionGeneration];
const owner = (r: typeof issues.$inferSelect) => [r.id, r.executionRunId, r.checkoutRunId,
  r.executionAgentNameKey, r.executionLockedAt];

export class QaCorrectionClaimRejected extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "qa_correction_claim_refused", { cause });
  }
}

/** Discovery follows only the actual original wakes. A reserved malformed ref never becomes ordinary. */
async function lineage(db: Connection, run: Run) {
  const chain: Run[] = [], wakes: DeliveryWake[] = [], seen = new Set<string>();
  let id: string | null = run.id;
  while (id) {
    if (seen.has(id) || seen.size >= 32) throw conflict("heartbeat_workflow_attempt_unproven");
    seen.add(id);
    const [current]: Run[] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    requireClaim(current && current.companyId === run.companyId);
    chain.push(current!);
    if (!current!.wakeupRequestId) return { chain, wakes, ref: null };
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, current!.wakeupRequestId!));
    requireClaim(wake);
    wakes.push(wake!);
    let ref: ReturnType<typeof readQaCorrectionWakeRef>;
    try { ref = readQaCorrectionWakeRef(wake!); }
    catch (error) { throw new QaCorrectionClaimRejected(error); }
    if (ref) return { chain, wakes, ref };
    id = current!.retryOfRunId;
  }
  return { chain, wakes, ref: null };
}
type Lineage = Awaited<ReturnType<typeof lineage>>;

/** Historical counters come from issuance; mutable display counters cannot restamp the original proof. */
async function prove(db: Connection, run: Run, l: Lineage) {
  requireClaim(l.ref && same(identity(l.chain[0]!), identity(run)));
  const h = await readIssuedQaCorrectionFollowupForAttempt(db, l.ref!), target = h.followup.target;
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, target.stepRunId));
  requireClaim(step && step.workflowRunId === l.ref!.workflowRunId && step.issueId === target.issueId
    && step.stepId === target.stepId);
  const first = l.chain[0]!, wake = l.wakes[0]!;
  requireClaim((first.workflowStepRunId === null || first.workflowStepRunId === wake.workflowStepRunId)
    && (first.workflowExecutionGeneration === null || first.workflowExecutionGeneration === wake.workflowExecutionGeneration));
  await producerAttempt(db, { ...first, workflowStepRunId: wake.workflowStepRunId,
    workflowExecutionGeneration: wake.workflowExecutionGeneration },
    { ...step!, executionGeneration: target.executionGeneration, retryCount: target.retryCount,
      iterationIndex: target.iterationIndex }, new Set(), first.status === "queued");
  return h;
}
/** Correction history has no technical-retry limit. Collect every historical proof's lock dependencies. */
async function scope(db: Db, h: DeliveryHistory) {
  const history = new Map<string, IssuedQaCorrection>([[h.issued.preparation.correctionId, h.issued]]);
  for (const issued of history.values()) {
    for (const source of issued.preparation.sources) {
      if (source.provenance.kind !== "prior_correction") continue;
      const prior = await readIssuedQaCorrection(db, { companyId: h.ref.companyId,
        workflowRunId: h.ref.workflowRunId, appliedEventId: source.provenance.appliedEventId });
      requireClaim(prior.preparation.missionId === h.issued.preparation.missionId);
      history.set(prior.preparation.correctionId, prior);
    }
  }
  const all = [...history.values()], preparations = all.map(s => s.preparation);
  return {
    targets: [h.followup.target, ...preparations.flatMap(p => [p.producer,
      ...p.authority.verdicts.map(v => v.qa), ...p.bindings.map(b => b.consumer)])],
    products: sorted(all.flatMap(s => [...s.preparation.sources.map(p => p.productId),
      ...s.applied.revisions.map(r => r.workProductId)])),
    bindings: sorted(preparations.flatMap(p => p.bindings.map(b => b.bindingId))),
    heartbeatIds: sorted(preparations.flatMap(p => [
      ...p.authority.verdicts.map(v => v.heartbeatRunId),
      ...p.sources.flatMap(s => s.provenance.kind === "workflow_producer" ? [s.provenance.workflowProducer.heartbeatRunId] : []),
      ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : []),
    ])),
  };
}
type Dependencies = Awaited<ReturnType<typeof scope>>;

async function issueRows(db: Connection, h: DeliveryHistory, s: Dependencies) {
  return db.select().from(issues).where(and(eq(issues.companyId, h.ref.companyId),
    inArray(issues.id, sorted(s.targets.map(t => t.issueId))))).orderBy(asc(issues.id));
}
async function heartbeats(db: Connection, h: DeliveryHistory, l: Lineage,
  rows: Awaited<ReturnType<typeof issueRows>>, s: Dependencies) {
  const ids = [...s.heartbeatIds, ...l.chain.map(r => r.id),
    ...rows.flatMap(r => [r.executionRunId, r.checkoutRunId])].filter((id): id is string => !!id);
  const found = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, h.ref.companyId),
    or(inArray(heartbeatRuns.issueId, rows.map(r => r.id)), inArray(heartbeatRuns.id, ids))));
  const all = new Map(found.map(r => [r.id, r]));
  requireClaim(ids.every(id => all.has(id)));
  // Include technical parents before locking anything. Set membership terminates corrupt cycles.
  for (const row of all.values()) {
    if (!row.retryOfRunId || all.has(row.retryOfRunId)) continue;
    const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.retryOfRunId));
    requireClaim(parent && parent.companyId === h.ref.companyId);
    all.set(parent!.id, parent!);
  }
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function observe(db: Db, run: Run, l: Lineage) {
  const h = await readQaCorrectionFollowupDb(db, l.ref!, readIssuedQaCorrection);
  const token = await observeQaCorrectionFollowup(db, l.ref!, readIssuedQaCorrection);
  const dependencies = await scope(db, h), rows = await issueRows(db, h, dependencies);
  const observed = await heartbeats(db, h, l, rows, dependencies);
  requireClaim(observed.some(r => r.id === run.id));
  return { h, token, rows, observed, dependencies };
}
type Observation = Awaited<ReturnType<typeof observe>>;

async function lock(tx: DeliveryTx, run: Run, l: Lineage, o: Observation,
  admit: (db: Db) => Promise<void>) {
  const p = o.h.issued.preparation;
  if (p.authority.kind === "quality_current_output") {
    await lockQualityAttemptBudget(tx, { companyId: run.companyId, actionId: p.authority.actionId, now: new Date() });
  }
  // Existing admission locks every mission/run identity (including the original wake) before any heartbeat.
  await admit(tx as unknown as Db);
  await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    inArray(heartbeatRuns.id, o.observed.map(r => r.id)))).orderBy(asc(heartbeatRuns.id)).for("update");
  const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
  requireClaim(current);
  if (run.status === "queued" && current!.status !== "queued") return false;
  await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId),
    inArray(issues.id, o.rows.map(r => r.id)))).orderBy(asc(issues.id)).for("update");
  const rows = await issueRows(tx, o.h, o.dependencies), observed = await heartbeats(tx, o.h, l, rows, o.dependencies);
  requireClaim(same(rows.map(owner), o.rows.map(owner))
    && same(observed.map(identity), o.observed.map(identity)));
  await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, p.workflowRunId),
    inArray(workflowStepRuns.id, sorted(o.dependencies.targets.map(t => t.stepRunId)))))
    .orderBy(asc(workflowStepRuns.id)).for("update");
  await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, run.companyId),
    inArray(issueWorkProducts.id, o.dependencies.products))).orderBy(asc(issueWorkProducts.id)).for("update");
  await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, run.companyId),
    eq(workflowStepOutputBindings.workflowRunId, p.workflowRunId),
    inArray(workflowStepOutputBindings.id, o.dependencies.bindings)))
    .orderBy(asc(workflowStepOutputBindings.id)).for("update");
  const wakeIds = sorted([...l.wakes.map(w => w.id),
    ...o.observed.flatMap(r => r.wakeupRequestId ? [r.wakeupRequestId] : [])]);
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds))
    .orderBy(asc(agentWakeupRequests.id)).for("update");
  return true;
}

async function currentPermission(tx: DeliveryTx, run: Run, o: Observation) {
  const h = await readCurrentQaCorrectionFollowup(tx, o.h.ref, o.token, readIssuedQaCorrection);
  const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)));
  const issue = h.database.target.issue, verdict = h.issued.preparation.authority.verdicts.find(v => same(v.qa, h.followup.target));
  const origin = o.observed.find(r => r.id === verdict?.heartbeatRunId);
  requireClaim(agent && (issue.assigneeAgentId ? issue.assigneeAgentId === run.agentId : origin?.agentId === run.agentId)
    && !issue.hiddenAt && issue.status !== "cancelled" && (issue.status !== "done" || h.followup.operation === "recheck"));
  const policy = parseObject(parseObject(agent!.runtimeConfig).heartbeat);
  requireClaim(run.invocationSource === "timer" ? asBoolean(policy.enabled, true)
    : asBoolean(policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation, true));
}

/** No files or root impersonation in a savepoint. Real roots observe afresh at BOTH execution boundaries. */
export async function withQaCorrectionClaimRoot<T>(db: Db, run: Run,
  admit: (db: Db) => Promise<void>, write: (db: Db) => Promise<T>): Promise<Boundary<T>> {
  const l = await lineage(db, run);
  if (!l.ref) {
    return db.transaction(async tx => {
      const t = tx as unknown as Db;
      await admit(t);
      return { kind: "performed" as const, value: await write(t) };
    });
  }
  try {
    await prove(db, run, l);
    if (is(db, PgTransaction)) {
      registerQaCorrectionRootDrain(db, run.agentId);
      return { kind: "root_deferred" };
    }
    const o = await observe(db, run, l);
    return await db.transaction(async tx => {
      if (!await lock(tx, run, l, o, admit)) return { kind: "not_claimed" as const };
      const fresh = await lineage(tx, run);
      requireClaim(same(fresh, l));
      await prove(tx, run, fresh);
      await currentPermission(tx, run, o);
      return { kind: "performed" as const, value: await write(tx as unknown as Db) };
    });
  } catch (error) {
    if (isQaCorrectionRootOwnerRequired(error)) throw error;
    throw error instanceof QaCorrectionClaimRejected ? error : new QaCorrectionClaimRejected(error);
  }
}
