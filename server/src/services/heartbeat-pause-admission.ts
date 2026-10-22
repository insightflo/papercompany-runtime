import { isDeepStrictEqual as same } from "node:util";
import { and, eq, inArray, is, or } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, qualityActions,
  qualityActionGroups, qualityPolicyVersions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { qualityPolicySchema, retryEnvelopeSchema } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { budgetBlockers } from "./workflow/resume/preview-facts.js";
import { budgetService } from "./budgets.js";
import { asBoolean, parseObject } from "../adapters/utils.js";
import { type PauseReceipt } from "./heartbeat-pause-contract.js";
import { readPauseControls as controls, pauseExecutionIdentity as execution, pauseLinked as linked,
  readStoppedPauseOriginal, readPauseDeliveryOriginal, comparePauseDelivery, type PauseDeliveryOriginal } from "./heartbeat-pause-delivery.js";
import { readWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { parseQualityWakeKey, qualityWakeKey } from "./quality/native-wake.js";
import { lockQualityAttemptBudget } from "./quality/retry-budget.js";
import { readPolicyUsageTotals } from "./quality/policy-usage.js";
import { qualityProducerRetryCount } from "./work-products/quality-producer-attempt.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;
type Reader = Pick<Db, "select">;
const reject = (): never => { throw conflict("heartbeat_pause_child_unproven_or_changed"); };
const sorted = (ids: string[]) => [...new Set(ids)].sort();
type Proof = PauseDeliveryOriginal & { wake: Wake };

/** SELECT only. Historical delivery proves ancestry; only the current guard grants execution permission. */
export async function readPauseChildProof(db: Reader, h: Run, historical = false): Promise<Proof | null> {
  if (!h.wakeupRequestId) {
    if (h.retryOfRunId && (await controls(db, h.agentId)).some(p => p.kind === "receipt"
      && p.delivery?.heartbeatRunId === h.id)) return reject();
    return null;
  }
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, h.wakeupRequestId));
  if (!wake) return reject();
  const reserved = wake.requestKind === "agent_pause_resume" || wake.reason === "agent_pause_resume";
  if (!reserved && !h.retryOfRunId) return null;
  const records = await controls(db, h.agentId);
  const matches = records.filter((p): p is PauseReceipt => p.kind === "receipt"
    && (p.delivery?.heartbeatRunId === h.id || p.delivery?.wakeupRequestId === wake.id));
  if (!reserved && !matches.length) return null;
  if (matches.length !== 1 || !reserved) return reject();
  const receipt = matches[0]!, i = receipt.identity, f = i.workflow;
  const original = await readStoppedPauseOriginal(db, receipt), { parent } = original;
  const heads = original.records.filter(p => p.kind === "head");
  if (i.companyId !== h.companyId || i.agentId !== h.agentId || !receipt.delivery || receipt.delivery.heartbeatRunId !== h.id || receipt.delivery.wakeupRequestId !== wake.id
    || h.retryOfRunId !== parent.id || !linked(h, wake) || wake.source !== "automation"
    || wake.requestedByActorType !== "system" || wake.requestKind !== "agent_pause_resume"
    || wake.reason !== wake.requestKind || wake.idempotencyKey !== null
    || Object.hasOwn(wake.payload ?? {}, "qaCorrectionFollowup") || wake.qualityAcceptance !== null
    || h.processLossRetryCount !== i.execution.processLossRetryCount
    || parent.createdAt > h.createdAt || (parent.startedAt && parent.startedAt > wake.requestedAt)
    || wake.requestedAt < new Date(receipt.stopped!.observedAt)
    || (h.startedAt && h.startedAt < wake.requestedAt) || wake.missionId !== i.missionId
    || wake.workflowRunId !== (f?.runId ?? null) || wake.workflowStepRunId !== (f?.stepRunId ?? null)
    || wake.workflowExecutionGeneration !== (f?.executionGeneration ?? null)) return reject();
  if (!historical && (heads[0]!.scopeId !== receipt.ownerScopeId || receipt.invalidated)) return reject();
  if (f) {
    const p = readWorkflowAttemptProof(wake);
    if (p.retryCount !== f.retryCount || p.iterationIndex !== f.iterationIndex
      || p.executionGeneration !== f.executionGeneration || p.parentHeartbeatRunId !== parent.id) return reject();
  }
  return { ...original, wake };
}

type Entry = { run: Run; wake: Wake; pause: Proof | null };
async function discover(db: Reader, supplied: Run, pending?: PauseDeliveryOriginal) {
  const entries: Entry[] = [], seen = new Set<string>();
  let id: string | null = supplied.id, missingWake = false;
  while (id) {
    if (seen.has(id) || seen.size >= 32) return reject();
    seen.add(id);
    const [run]: Run[] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    if (!run || run.companyId !== supplied.companyId || run.agentId !== supplied.agentId
      || run.issueId !== supplied.issueId) return reject();
    const [wake] = run.wakeupRequestId ? await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId)) : [];
    if (!wake) {
      await readPauseChildProof(db, run, true);
      missingWake = true;
    } else entries.push({ run, wake, pause: await readPauseChildProof(db, run, true) });
    id = run.retryOfRunId;
  }
  if (!pending && !entries.some(e => e.pause)) return null;
  if (missingWake || entries.some(e => !linked(e.run, e.wake))) return reject();
  for (const [index, e] of entries.entries()) {
    if (!e.run.retryOfRunId || e.pause) continue;
    const parent = entries[index + 1]?.run, w = e.wake;
    if (!parent || parent.id !== e.run.retryOfRunId || !parent.startedAt
      || parent.startedAt > (e.run.startedAt ?? e.run.createdAt) || w.idempotencyKey !== null
      || !["process_lost_retry", "adapter_failed_retry", "adapter_fallback"].includes(w.requestKind ?? "")
      || w.reason !== w.requestKind || w.source !== "automation" || w.requestedByActorType !== "system") return reject();
  }
  const first = pending ?? entries.find(e => e.pause)!.pause!, f = first.receipt.identity.workflow;
  const root = entries[entries.length - 1]!, ref = readQaCorrectionWakeRef(root.wake);
  // Correction roots have parent=null. Historical source products never supply extra quality locks.
  if (ref && (root.run.retryOfRunId !== null || !f || ref.companyId !== supplied.companyId
    || ref.workflowRunId !== f.runId || entries.some(e => e.wake.workflowStepRunId !== f.stepRunId
      || e.wake.issueId !== first.receipt.identity.issueId))) return reject();
  const native = ref ? null : parseQualityWakeKey(root.wake.idempotencyKey);
  if (native && (!f || qualityWakeKey(native) !== root.wake.idempotencyKey)) return reject();
  const [step] = f ? await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId)) : [];
  if (f) {
    if (!step) return reject();
    const { producerAttempt } = await import("./work-products/producer-attempt.js");
    await producerAttempt(db, { ...entries[0]!.run, workflowStepRunId: f.stepRunId,
      workflowExecutionGeneration: f.executionGeneration }, { ...step, executionGeneration: f.executionGeneration,
      retryCount: f.retryCount, iterationIndex: f.iterationIndex }, new Set(), supplied.status === "queued" || (!!pending && supplied.id === pending.parent.id && !supplied.startedAt));
  }
  return { entries, first, root, qa: !!ref, native };
}
type Discovery = NonNullable<Awaited<ReturnType<typeof discover>>>;
export type PauseChildAdmission = Discovery & { tx: Db };
function transaction(tx: Db) { if (!is(tx, PgTransaction)) return reject(); }

/** Discovery and native prefix precede mission/run. QA's root already owns its quality prefix. */
export async function preparePauseChildAdmission(tx: Db, run: Run, admit: (missionId?: string | null) => Promise<void>): Promise<PauseChildAdmission | null> {
  transaction(tx);
  const found = await discover(tx, run);
  if (found?.native) await lockQualityAttemptBudget(tx as unknown as Parameters<typeof lockQualityAttemptBudget>[0],
    { companyId: run.companyId, actionId: found.native.actionId, now: new Date() });
  await admit(found?.first.receipt.identity.missionId);
  if (!found) return null;
  await tx.select().from(companies).where(eq(companies.id, run.companyId)).for("share");
  await tx.select().from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).for("share");
  return { ...found, tx };
}
const deliveryObservations = new WeakMap<PauseDeliveryObservation, Discovery>();
export type PauseDeliveryObservation = { readonly receiptId: string };
function captured(observation: PauseDeliveryObservation) {
  const found = deliveryObservations.get(observation);
  if (!found) return reject();
  return found;
}
async function deliveryDiscovery(db: Reader, receiptId: string) {
  const original = await readPauseDeliveryOriginal(db, receiptId);
  const [child] = original.receipt.delivery?.heartbeatRunId ? await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, original.receipt.delivery.heartbeatRunId)) : [];
  if (original.receipt.delivery && (!child || !await readPauseChildProof(db, child))) return reject();
  const found = await discover(db, child ?? original.parent, original);
  if (!found) return reject();
  return found;
}
export async function observePauseDeliveryAdmission(db: Reader, receiptId: string): Promise<PauseDeliveryObservation> {
  const found = await deliveryDiscovery(db, receiptId), handle = Object.freeze({ receiptId });
  deliveryObservations.set(handle, found);
  return handle;
}
export function pauseDeliveryRun(observation: PauseDeliveryObservation) {
  return structuredClone(captured(observation).entries[0]!.run);
}
export function pauseDeliveryAncestors(plan: PauseChildAdmission) { return plan.entries.map(e => e.run.id); }
/** This separate reader alone permits an unstarted terminal original, proved by its exact saved receipt. */
export async function provePauseDeliveryAttempt(db: Reader, observation: PauseDeliveryObservation,
  run: Run, step: typeof workflowStepRuns.$inferSelect) {
  const old = captured(observation), fresh = await deliveryDiscovery(db, observation.receiptId);
  comparePauseDelivery(old.first, fresh.first);
  if (!same(fresh.entries.map(identity), old.entries.map(identity)) || !same(identity({ ...old.entries[0]!, run }), identity(old.entries[0]!))) return reject();
  const f = fresh.first.receipt.identity.workflow;
  if (!f || step.id !== f.stepRunId || step.executionGeneration !== f.executionGeneration
    || step.retryCount !== f.retryCount || step.iterationIndex !== f.iterationIndex) return reject();
  const { producerAttempt } = await import("./work-products/producer-attempt.js");
  await producerAttempt(db, { ...run, workflowStepRunId: f.stepRunId, workflowExecutionGeneration: f.executionGeneration },
    step, new Set(), run.status === "queued" || (run.id === fresh.first.parent.id && !run.startedAt));
}
export async function preparePauseDeliveryAdmission(tx: Db, observation: PauseDeliveryObservation,
  admit: (missionId: string | null) => Promise<void>): Promise<PauseChildAdmission> {
  transaction(tx);
  const found = captured(observation), run = found.entries[0]!.run;
  if (found.native) await lockQualityAttemptBudget(tx as unknown as Parameters<typeof lockQualityAttemptBudget>[0],
    { companyId: run.companyId, actionId: found.native.actionId, now: new Date() });
  await admit(found.first.receipt.identity.missionId);
  await tx.select().from(companies).where(eq(companies.id, run.companyId)).for("share");
  await tx.select().from(agents).where(eq(agents.id, run.agentId)).for("share");
  return { ...found, tx };
}
function identity(e: Entry) {
  const h = e.run, w = e.wake;
  return [h.id, h.companyId, h.agentId, h.issueId, h.wakeupRequestId, h.workflowStepRunId,
    h.workflowExecutionGeneration, execution(h), w.id, w.companyId, w.agentId, w.issueId,
    w.missionId, w.workflowRunId, w.workflowStepRunId, w.workflowExecutionGeneration, w.runId,
    w.source, w.requestKind, w.reason, w.idempotencyKey, w.payload, w.qualityAcceptance];
}
const deliveryIdentity = (e: Entry) => [identity(e), e.run.contextSnapshot, e.run.invocationSource,
  e.run.status, e.run.startedAt, e.run.createdAt, e.wake.requestedAt, e.wake.status,
  e.wake.requestedByActorType, e.wake.requestedByActorId];
async function nativeCurrent(tx: Db, run: Run, p: Discovery, step: typeof workflowStepRuns.$inferSelect) {
  if (!p.native) return;
  const [action] = await tx.select().from(qualityActions).where(and(eq(qualityActions.id, p.native.actionId),
    eq(qualityActions.companyId, run.companyId)));
  const [policyRow] = action ? await tx.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, action.policyVersionId)) : [];
  const [group] = action ? await tx.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, action.groupId)) : [];
  if (!action || action.cancelRequestedAt || !policyRow || !policyRow.approvedAt || !policyRow.enabledAt
    || policyRow.disabledAt || policyRow.companyId !== run.companyId || !group
    || group.companyId !== run.companyId || group.policyVersionId !== action.policyVersionId) return reject();
  const policy = qualityPolicySchema.parse(policyRow.definition), envelope = retryEnvelopeSchema.parse(action.retryEnvelope);
  const now = new Date(), usage = (key: string) => {
    const n = group.usage[key] ?? 0;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return reject();
    return n;
  };
  const totals = await readPolicyUsageTotals(tx, { companyId: run.companyId, policyVersionId: action.policyVersionId,
    windowStart: new Date(policy.periodStart), windowEnd: new Date(policy.periodEnd) });
  if (policy.nativeOwnership !== "native-active-plugin-disabled" || now < new Date(policy.periodStart)
    || now >= new Date(policy.periodEnd) || now >= new Date(envelope.deadlineAt)
    || (group.deadlineAt && now >= group.deadlineAt)
    || ![...policy.authorAgentIds, ...policy.verifierAgentIds].includes(run.agentId)
    || totals.executionAttempts > envelope.maxExecutorAttempts
    || totals.reservedCostCents + totals.chargedCostCents > policy.maxCostCentsPerPeriod
    || usage("executionAttempts") > envelope.maxExecutorAttempts
    || usage("reservedCostCents") + usage("chargedCostCents") > envelope.maxCumulativeCostCents
    || await qualityProducerRetryCount(tx, p.root.wake, { ...p.root.run,
      workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration }, step) !== step.retryCount) return reject();
}

async function lockAdmission(tx: Db, plan: PauseChildAdmission, mode: "share" | "update", beforeControls: () => Promise<void>) {
  const ids = sorted(plan.entries.map(e => e.run.id));
  const issueIds = sorted(plan.entries.flatMap(e => e.run.issueId ? [e.run.issueId] : []));
  const stepIds = sorted(plan.entries.flatMap(e => e.wake.workflowStepRunId ? [e.wake.workflowStepRunId] : []));
  const wakeIds = sorted(plan.entries.map(e => e.wake.id));
  // A proved correction has these exact chain/wake IDs and one issued target issue/step in the root lock set.
  if (!plan.qa) {
    await tx.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids)).orderBy(heartbeatRuns.id).for("update");
    if (issueIds.length) await tx.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(issues.id).for("update");
    if (stepIds.length) await tx.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, stepIds)).orderBy(workflowStepRuns.id).for("share");
    await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)).orderBy(agentWakeupRequests.id).for(mode);
  }
  await beforeControls();
  const records = plan.first.records, heads = records.filter(p => p.kind === "head");
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, heads.map(p => p.id))).for(mode);
  const scopes = sorted([plan.first.receipt.originScopeId, plan.first.receipt.ownerScopeId, ...plan.entries.flatMap(e => e.pause ? [e.pause.receipt.originScopeId, e.pause.receipt.ownerScopeId] : [])]);
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, scopes)).orderBy(agentWakeupRequests.id).for(mode);
  const receipts = sorted([plan.first.receipt.id, ...plan.entries.flatMap(e => e.pause ? [e.pause.receipt.id] : [])]);
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, receipts)).orderBy(agentWakeupRequests.id).for(mode);
}

/** Transaction only; QA owns its earlier lock set before claim/start reaches this guard. */
export async function assertCurrentPauseChild(tx: Db, run: Run, plan: PauseChildAdmission | null) {
  transaction(tx);
  if (!plan) { if (await discover(tx, run)) return reject(); return; }
  if (plan.tx !== tx || !same(identity({ ...plan.entries[0]!, run }), identity(plan.entries[0]!))) return reject();
  await lockAdmission(tx, plan, "share", async () => {});
  const fresh = await discover(tx, run);
  // Any new lineage/quality/lock target requires rollback; no late prefix or attempt locks.
  if (!fresh || !same(fresh.entries.map(identity), plan.entries.map(identity))
    || fresh.qa !== plan.qa || !same(fresh.native, plan.native)
    || !same(fresh.entries.map(e => e.pause?.receipt), plan.entries.map(e => e.pause?.receipt))) return reject();
  const current = await readPauseChildProof(tx, fresh.entries.find(e => e.pause)!.run);
  if (!current || current.receipt.id !== plan.first.receipt.id) return reject();
  await assertRuntime(tx, run, fresh, current.receipt);
}
export async function assertCurrentPauseDelivery(tx: Db, observation: PauseDeliveryObservation,
  plan: PauseChildAdmission, beforeControls: () => Promise<void>) {
  transaction(tx);
  const old = captured(observation), run = old.entries[0]!.run;
  if (plan.tx !== tx || !same(plan.entries.map(identity), old.entries.map(identity))) return reject();
  await lockAdmission(tx, plan, "update", beforeControls);
  const fresh = await deliveryDiscovery(tx, observation.receiptId);
  comparePauseDelivery(old.first, fresh.first);
  if (!same(fresh.entries.map(deliveryIdentity), old.entries.map(deliveryIdentity)) || fresh.qa !== plan.qa
    || !same(fresh.native, plan.native) || !same(fresh.entries.map(e => e.pause?.receipt), plan.entries.map(e => e.pause?.receipt))) return reject();
  await assertRuntime(tx, fresh.entries[0]!.run, fresh, fresh.first.receipt);
  return fresh.first;
}
async function assertRuntime(tx: Db, run: Run, plan: Discovery, receipt: PauseReceipt) {
  const i = receipt.identity, f = i.workflow;
  const ids = sorted(plan.entries.map(e => e.run.id));
  const issueIds = sorted(plan.entries.flatMap(e => e.run.issueId ? [e.run.issueId] : []));
  const [company] = await tx.select().from(companies).where(eq(companies.id, run.companyId));
  const [agent] = await tx.select().from(agents).where(eq(agents.id, run.agentId));
  if (!company || !agent || budgetBlockers(company).length || budgetBlockers(agent).length
    || agent.companyId !== run.companyId || !same(agent.permissions, i.observedPermissions)
    || ["paused", "terminated", "pending_approval"].includes(agent.status)) return reject();
  if (await budgetService(tx).getInvocationBlock(run.companyId, run.agentId, {
    issueId: i.issueId, projectId: typeof parseObject(run.contextSnapshot).projectId === "string"
      ? parseObject(run.contextSnapshot).projectId as string : null })) return reject();
  const policy = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  if (!(run.invocationSource === "timer" ? asBoolean(policy.enabled, true)
    : asBoolean(policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation, true))) return reject();
  const rows = issueIds.length ? await tx.select().from(issues).where(inArray(issues.id, issueIds)) : [];
  if (rows.length !== issueIds.length || rows.some(r => r.companyId !== run.companyId || r.hiddenAt
    || r.status === "cancelled" || (r.assigneeAgentId && r.assigneeAgentId !== run.agentId)
    || (!plan.qa && [r.executionRunId, r.checkoutRunId].some(id => id && !ids.includes(id))))) return reject();
  const live = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), or(eq(heartbeatRuns.wakeupRequestId, run.wakeupRequestId!),
      f ? eq(heartbeatRuns.workflowStepRunId, f.stepRunId) : undefined,
      run.issueId ? eq(heartbeatRuns.issueId, run.issueId) : undefined)));
  if (live.some(h => h.id !== run.id)) return reject();
  if (f) {
    const [step] = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
    const [workflow] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    if (!step || !workflow || workflow.dispatchAuthorityVersion !== f.observedAuthorityVersion
      || workflow.status === "cancelled" || step.executionGeneration !== f.executionGeneration
      || step.retryCount !== f.retryCount || step.iterationIndex !== f.iterationIndex) return reject();
    await nativeCurrent(tx, run, plan, step);
  }
}
