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
import { PAUSE_CONTROL_COLUMNS, readPauseControl, type PauseControl, type PauseReceipt } from "./heartbeat-pause-contract.js";
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
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
async function controls(db: Reader, agentId: string) {
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
function execution(h: Run) {
  return { scopeKind: h.executionScopeKind, epoch: h.executionEpoch, token: h.executionToken,
    retryOfRunId: h.retryOfRunId, processLossRetryCount: h.processLossRetryCount,
    ownerId: h.executorOwnerId, ownerLeaseEpoch: h.executorOwnerLeaseEpoch, ownerLeaseToken: h.executorOwnerLeaseToken };
}
function typed(h: Run, w: Wake) {
  return (h.workflowStepRunId === w.workflowStepRunId && h.workflowExecutionGeneration === w.workflowExecutionGeneration)
    || (!h.startedAt && h.workflowStepRunId === null && h.workflowExecutionGeneration === null);
}
function linked(h: Run, w: Wake) {
  return w.companyId === h.companyId && w.agentId === h.agentId && w.issueId === h.issueId
    && h.wakeupRequestId === w.id && w.runId === h.id && w.status !== "coalesced" && typed(h, w);
}
type Proof = { receipt: PauseReceipt; parent: Run; wake: Wake; originalWake: Wake; records: PauseControl[] };

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
  const heads = records.filter(p => p.kind === "head");
  const scope = (id: string) => records.find(p => p.kind === "scope" && p.id === id);
  const origin = scope(receipt.originScopeId), owner = scope(receipt.ownerScopeId);
  if (records.some(p => p.companyId !== h.companyId) || heads.length !== 1
    || receipt.companyId !== h.companyId || receipt.agentId !== h.agentId || receipt.cause !== "manual_pause"
    || origin?.kind !== "scope" || owner?.kind !== "scope" || origin.cause !== "manual_pause" || owner.cause !== "manual_pause"
    || !origin.receiptIds.includes(receipt.id) || !owner.receiptIds.includes(receipt.id)
    || receipt.resumeScopeId !== owner.id || !receipt.stopped
    || !receipt.delivery || receipt.delivery.heartbeatRunId !== h.id || receipt.delivery.wakeupRequestId !== wake.id
    || h.retryOfRunId !== i.heartbeatRunId || !linked(h, wake) || wake.source !== "automation"
    || wake.requestedByActorType !== "system" || wake.requestKind !== "agent_pause_resume"
    || wake.reason !== wake.requestKind || wake.idempotencyKey !== null
    || Object.hasOwn(wake.payload ?? {}, "qaCorrectionFollowup") || wake.qualityAcceptance !== null
    || h.processLossRetryCount !== i.execution.processLossRetryCount) return reject();
  if (!historical && (heads[0]!.scopeId !== owner.id || receipt.invalidated)) return reject();
  const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, i.heartbeatRunId));
  const [originalWake] = i.wakeupRequestId ? await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, i.wakeupRequestId)) : [];
  if (!parent || !originalWake || !linked(parent, originalWake) || parent.companyId !== h.companyId
    || parent.agentId !== h.agentId || parent.issueId !== i.issueId || h.issueId !== i.issueId
    || parent.wakeupRequestId !== i.wakeupRequestId || !same(execution(parent), i.execution)
    || !["cancelled", "failed", "succeeded", "timed_out"].includes(parent.status)
    || parent.createdAt > h.createdAt || (parent.startedAt && parent.startedAt > wake.requestedAt)
    || wake.requestedAt < new Date(receipt.stopped.observedAt)
    || (h.startedAt && h.startedAt < wake.requestedAt)
    || originalWake.missionId !== i.missionId || wake.missionId !== i.missionId) return reject();
  for (const w of [wake, originalWake]) {
    if (w.source === PAUSE_CONTROL_COLUMNS.source || w.workflowRunId !== (f?.runId ?? null)
      || w.workflowStepRunId !== (f?.stepRunId ?? null)
      || w.workflowExecutionGeneration !== (f?.executionGeneration ?? null)) return reject();
    if (f) {
      const p = readWorkflowAttemptProof(w);
      if (p.retryCount !== f.retryCount || p.iterationIndex !== f.iterationIndex
        || p.executionGeneration !== f.executionGeneration
        || p.parentHeartbeatRunId !== (w.id === wake.id ? parent.id : i.execution.retryOfRunId)) return reject();
    }
  }
  if (f) {
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    if (!step || !run || run.companyId !== h.companyId || run.workflowId !== f.workflowId
      || run.missionId !== i.missionId || step.workflowRunId !== f.runId
      || step.stepId !== f.stepId || step.issueId !== i.issueId) return reject();
  }
  return { receipt, parent, wake, originalWake, records };
}

type Entry = { run: Run; wake: Wake; pause: Proof | null };
async function discover(db: Reader, supplied: Run) {
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
  if (!entries.some(e => e.pause)) return null;
  if (missingWake || entries.some(e => !linked(e.run, e.wake))) return reject();
  for (const [index, e] of entries.entries()) {
    if (!e.run.retryOfRunId || e.pause) continue;
    const parent = entries[index + 1]?.run, w = e.wake;
    if (!parent || parent.id !== e.run.retryOfRunId || !parent.startedAt
      || parent.startedAt > (e.run.startedAt ?? e.run.createdAt) || w.idempotencyKey !== null
      || !["process_lost_retry", "adapter_failed_retry", "adapter_fallback"].includes(w.requestKind ?? "")
      || w.reason !== w.requestKind || w.source !== "automation" || w.requestedByActorType !== "system") return reject();
  }
  const first = entries.find(e => e.pause)!.pause!, f = first.receipt.identity.workflow;
  const root = entries[entries.length - 1]!, ref = readQaCorrectionWakeRef(root.wake);
  // Correction roots have parent=null. Historical source products never supply extra quality locks.
  if (ref && (root.run.retryOfRunId !== null || !f || ref.companyId !== supplied.companyId
    || ref.workflowRunId !== f.runId || entries.some(e => e.wake.workflowStepRunId !== f.stepRunId
      || e.wake.issueId !== first.receipt.identity.issueId))) return reject();
  const native = ref ? null : parseQualityWakeKey(root.wake.idempotencyKey);
  if (native && qualityWakeKey(native) !== root.wake.idempotencyKey) return reject();
  const [step] = f ? await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId)) : [];
  if (f) {
    if (!step) return reject();
    const { producerAttempt } = await import("./work-products/producer-attempt.js");
    await producerAttempt(db, { ...entries[0]!.run, workflowStepRunId: f.stepRunId,
      workflowExecutionGeneration: f.executionGeneration }, { ...step, executionGeneration: f.executionGeneration,
      retryCount: f.retryCount, iterationIndex: f.iterationIndex }, new Set(), supplied.status === "queued");
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
function identity(e: Entry) {
  const h = e.run, w = e.wake;
  return [h.id, h.companyId, h.agentId, h.issueId, h.wakeupRequestId, h.workflowStepRunId,
    h.workflowExecutionGeneration, execution(h), w.id, w.companyId, w.agentId, w.issueId,
    w.missionId, w.workflowRunId, w.workflowStepRunId, w.workflowExecutionGeneration, w.runId,
    w.source, w.requestKind, w.reason, w.idempotencyKey, w.payload, w.qualityAcceptance];
}
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

/** Transaction only; called AFTER QA current-input/owner checks, immediately before claim/start.
 * QA already locks these exact lineage IDs through its target; never add earlier-order locks there.
 */
export async function assertCurrentPauseChild(tx: Db, run: Run, plan: PauseChildAdmission | null) {
  transaction(tx);
  if (!plan) { if (await discover(tx, run)) return reject(); return; }
  if (plan.tx !== tx || !same(identity({ ...plan.entries[0]!, run }), identity(plan.entries[0]!))) return reject();
  const ids = sorted(plan.entries.map(e => e.run.id));
  const issueIds = sorted(plan.entries.flatMap(e => e.run.issueId ? [e.run.issueId] : []));
  const stepIds = sorted(plan.entries.flatMap(e => e.wake.workflowStepRunId ? [e.wake.workflowStepRunId] : []));
  const wakeIds = sorted(plan.entries.map(e => e.wake.id));
  // A proved correction has these exact chain/wake IDs and one issued target issue/step in the root lock set.
  if (!plan.qa) {
    await tx.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids)).orderBy(heartbeatRuns.id).for("update");
    if (issueIds.length) await tx.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(issues.id).for("update");
    if (stepIds.length) await tx.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, stepIds)).orderBy(workflowStepRuns.id).for("share");
    await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds)).orderBy(agentWakeupRequests.id).for("share");
  }
  const records = plan.first.records, heads = records.filter(p => p.kind === "head");
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, heads.map(p => p.id))).for("share");
  const scopes = sorted(plan.entries.flatMap(e => e.pause ? [e.pause.receipt.originScopeId, e.pause.receipt.ownerScopeId] : []));
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, scopes)).orderBy(agentWakeupRequests.id).for("share");
  const receipts = sorted(plan.entries.flatMap(e => e.pause ? [e.pause.receipt.id] : []));
  await tx.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, receipts)).orderBy(agentWakeupRequests.id).for("share");
  const fresh = await discover(tx, run);
  // Any new lineage/quality/lock target requires rollback; no late prefix or attempt locks.
  if (!fresh || !same(fresh.entries.map(identity), plan.entries.map(identity))
    || fresh.qa !== plan.qa || !same(fresh.native, plan.native)
    || !same(fresh.entries.map(e => e.pause?.receipt), plan.entries.map(e => e.pause?.receipt))) return reject();
  const current = await readPauseChildProof(tx, fresh.entries.find(e => e.pause)!.run);
  if (!current || current.receipt.id !== plan.first.receipt.id) return reject();
  const i = current.receipt.identity, f = i.workflow;
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
    await nativeCurrent(tx, run, fresh, step);
  }
}
