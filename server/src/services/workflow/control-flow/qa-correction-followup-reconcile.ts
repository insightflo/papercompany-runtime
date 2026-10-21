/**
 * C02/14A: discover structured correction authority without IO. An identifier-only signal
 * unwinds every savepoint before C03 prepares/stores/issues on the actual root connection.
 * Reentry queues the issued request; existing after-commit drains own public delivery.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { and, eq, inArray, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, heartbeatRuns, issueWorkProducts, issues, missions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { workProductProducerSchema, type WorkflowVerdictFinding } from "@paperclipai/shared";
import { createReplacementRootNotifications, currentReplacementRootNotifications,
  validateAndRegisterQaCorrectionRootDrain, withReplacementRootNotificationDb } from "../../issue-assignment-wakeup.js";
import { insertWorkflowWakeRequest } from "../../heartbeat-workflow-wake.js";
import { resolveWorkProductLocalFilePath } from "../../work-products/producer-seal.js";
import { qaCorrectionWakeKey } from "../../work-products/qa-correction-producer-attempt.js";
import { drainReplacementRootNotifications } from "../replacement-agent-delivery.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import { loadLatestQaRemediations, loadWorkflowApiFindings, loadPriorRejectedFindings } from "../validation-verdict-ledger.js";
import { resolveEdges } from "./edge-condition.js";
import { readCapBoostAmount } from "./types.js";
import { applyRecurrencePromotion } from "./rework-contract.js";
import { QaCorrectionReadError, parseQaCorrectionPreparationRow,
  validateQaCorrectionAuthority, requireQaCorrection } from "./qa-correction-authority.js";
import { hashQaCorrectionPayload, qaCorrectionAppliedKey, type QaCorrectionAttempt,
  type QaCorrectionPreparation } from "./qa-correction-contract.js";
import { beginQaCorrection } from "./qa-correction-prepare.js";
import { measureQaCorrectionSources } from "./qa-correction-measure.js";
import { storeQaCorrection } from "./qa-correction-storage.js";
import { commitQaCorrection } from "./qa-correction-commit.js";
import { qaCorrectionProductPointerSchema, readIssuedQaCorrection } from "./qa-correction-reader.js";
import { readQaCorrectionFollowupDb, readQaCorrectionFollowupConsumption } from "./qa-correction-followup.js";
import { readQaCorrectionDelivery, type CorrectionDeliveryInput } from "./qa-correction-delivery-receipt.js";
import { collectQaRemediationEligibility } from "./qa-remediation-qualification.js";
import type { TryQaRemediationInput, QaRemediationPassResult } from "./qa-remediation-contract.js";

type Input = Omit<TryQaRemediationInput, "refireQaStep">;
type Step = typeof workflowStepRuns.$inferSelect;
type Request = { runId: string; producerStepRunId: string; qaStepRunIds: string[]; verdictEventIds: string[] };
export class QaCorrectionReconcileRequired extends Error {
  constructor(readonly request: Request) { super("qa_correction_reconcile_required"); }
}
const attempt = (s: Step): QaCorrectionAttempt => ({ stepRunId: s.id, stepId: s.stepId, issueId: s.issueId!,
  executionGeneration: s.executionGeneration, retryCount: s.retryCount, iterationIndex: s.iterationIndex });
const ids = (values: string[]) => [...values].sort();

const requestFor = (p: QaCorrectionPreparation): Request => ({ runId: p.workflowRunId,
  producerStepRunId: p.producer.stepRunId, qaStepRunIds: ids(p.authority.verdicts.map(v => v.qa.stepRunId)),
  verdictEventIds: ids(p.authority.verdicts.map(v => v.eventId)) });

/** History identifies pending B; current DB checks still fence its delivery, never certify QA of B. */
async function currentIssued(db: Db, run: typeof workflowRuns.$inferSelect, steps: readonly Step[]) {
  const found: Array<{ p: QaCorrectionPreparation; appliedEventId: string; targets: string[] }> = [];
  if (!run.missionId || ["completed", "cancelled", "aborted", "failed", "timed-out"].includes(run.status)) return found;
  // Fence cancelled attempts at discovery; status sync must still settle them without delivery.
  const cancelledIssues = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, run.companyId),
    inArray(issues.id, steps.flatMap(s => s.issueId ? [s.issueId] : [])), eq(issues.status, "cancelled")));
  steps = steps.filter(s => s.status !== "cancelled" && !cancelledIssues.some(i => i.id === s.issueId));
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
    eq(workflowTransitionEvents.eventType, "qa_correction_prepared")));
  const pins = await db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, run.companyId), eq(workflowStepOutputBindings.workflowRunId, run.id)));
  for (const row of rows) {
    const p = parseQaCorrectionPreparationRow(row);
    if (p.missionId !== run.missionId || p.dispatchAuthorityVersion !== run.dispatchAuthorityVersion
      || p.authority.kind !== "workflow_qa" || !p.bindings.length
      || p.sources.some(s => s.provenance.kind === "registered_legacy")
      || !steps.some(s => same(attempt(s), p.producer))
      || !p.authority.verdicts.every(v => steps.some(s => same(attempt(s), v.qa)))) continue;
    const [applied] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
      eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(p.correctionId))));
    if (!applied) continue;
    const proof = await readIssuedQaCorrection(db, { companyId: run.companyId, workflowRunId: run.id, appliedEventId: applied.id });
    requireQaCorrection(same(proof.preparation, p), "record");
    if (!proof.applied.bindingChanges.every(c => pins.some(b => b.id === c.bindingId && b.workProductId === c.toProductId))) continue;
    const targets: string[] = [];
    for (const f of proof.followups) {
      const ref = { companyId: run.companyId, workflowRunId: run.id, appliedEventId: applied.id, requestId: f.requestId };
      if (await readQaCorrectionFollowupConsumption(db, ref, readIssuedQaCorrection)) continue;
      await readQaCorrectionFollowupDb(db, ref, readIssuedQaCorrection);
      targets.push(f.target.stepRunId);
    }
    if (targets.length) found.push({ p, appliedEventId: applied.id, targets });
  }
  return found;
}

/** Only a proven pending correction (queued or delivered) suppresses the competing ordinary recheck. */
export async function queueCurrentIssuedQaCorrectionTargets(db: Db, run: typeof workflowRuns.$inferSelect, steps: readonly Step[]) {
  const issueIds = new Set<string>();
  for (const issued of await currentIssued(db, run, steps)) {
    await acceptIssued(db, issued.p, issued.appliedEventId);
    for (const id of issued.targets) issueIds.add(steps.find(s => s.id === id)!.issueId!);
  }
  return issueIds;
}

/** Registered proof/bindings opt in; unsupported legacy callers keep their existing path. */
export async function discoverQaCorrection(input: Input) {
  const { db, run, producerRun } = input;
  if (run.status === "cancelled" || !run.missionId || !producerRun.issueId) return null;
  const [currentRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  requireQaCorrection(currentRun && currentRun.companyId === run.companyId, "scope");
  const issued = (await currentIssued(db, currentRun, [producerRun,
    ...input.rejectedQas.flatMap(q => q.qaRun ? [q.qaRun] : [])])).find(i => i.p.producer.stepRunId === producerRun.id);
  if (issued) return { p: issued.p, request: requestFor(issued.p) };
  const verdicts: QaCorrectionPreparation["authority"]["verdicts"] = [];
  for (const rejected of input.rejectedQas) {
    const qa = rejected.qaRun;
    if (!qa?.issueId) return null;
    const loaded = await loadLatestQaRemediations({ db, companyId: run.companyId, issueId: qa.issueId });
    if (!loaded?.heartbeatRunId || loaded.workflowStepRunId !== qa.id) return null;
    verdicts.push({ eventId: loaded.sourceVerdictEventId, heartbeatRunId: loaded.heartbeatRunId,
      qa: attempt(qa), remediationsHash: hashQaCorrectionPayload(loaded.remediations.items) });
  }
  if (!verdicts.length) return null;
  const request: Request = { runId: run.id, producerStepRunId: producerRun.id,
    qaStepRunIds: ids(verdicts.map(v => v.qa.stepRunId)), verdictEventIds: ids(verdicts.map(v => v.eventId)) };
  // Look up the original A preparation before observing today's B products or newer heartbeats.
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
    eq(workflowTransitionEvents.workflowStepRunId, producerRun.id),
    eq(workflowTransitionEvents.eventType, "qa_correction_prepared")));
  for (const row of rows) {
    const p = parseQaCorrectionPreparationRow(row);
    if (p.missionId === run.missionId && p.dispatchAuthorityVersion === currentRun.dispatchAuthorityVersion
      && same(p.producer, attempt(producerRun)) && p.authority.kind === "workflow_qa"
      && same(ids(p.authority.verdicts.map(v => v.eventId)), request.verdictEventIds)
      && same(ids(p.authority.verdicts.map(v => v.qa.stepRunId)), request.qaStepRunIds)) return { p, request };
  }
  const eligible = await collectQaRemediationEligibility(input, "prepare");
  if (eligible.status !== "eligible") return null;
  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, run.companyId), eq(issueWorkProducts.issueId, producerRun.issueId),
    eq(issueWorkProducts.status, "active")));
  const pins = await db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, run.companyId), eq(workflowStepOutputBindings.workflowRunId, run.id),
    eq(workflowStepOutputBindings.referencedStepId, producerRun.stepId)));
  const selected = products.filter(p => pins.some(b => b.workProductId === p.id
    && request.qaStepRunIds.includes(b.consumerStepRunId)));
  if (!selected.length || selected.some(p => !Object.hasOwn(p.metadata ?? {}, "workflowProducer")
    && !Object.hasOwn(p.metadata ?? {}, "qaCorrection"))) return null;
  const sources: QaCorrectionPreparation["sources"] = [];
  for (const product of selected) {
    const file = resolveWorkProductLocalFilePath(product);
    requireQaCorrection(file && path.isAbsolute(file), "source");
    const hint = product.metadata?.qaCorrection;
    sources.push({ productId: product.id, provenance: hint === undefined
      ? { kind: "workflow_producer", workflowProducer: workProductProducerSchema.parse(product.metadata?.workflowProducer) }
      : { kind: "prior_correction", appliedEventId: qaCorrectionProductPointerSchema.parse(hint).appliedEventId } });
  }
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const bindings = pins.filter(b => selected.some(p => p.id === b.workProductId)).map(b => {
    const consumer = steps.find(s => s.id === b.consumerStepRunId);
    requireQaCorrection(consumer?.issueId, "binding");
    return { bindingId: b.id, consumer: attempt(consumer), referencedStepId: b.referencedStepId,
      expectedProductId: b.workProductId };
  });
  const p: QaCorrectionPreparation = { schemaVersion: "workflow.qa-correction.prepare.v1", correctionId: randomUUID(),
    companyId: run.companyId, missionId: run.missionId, workflowRunId: run.id,
    dispatchAuthorityVersion: currentRun.dispatchAuthorityVersion, producer: attempt(producerRun),
    authority: { kind: "workflow_qa", verdicts, toolEvidence: null }, sources, bindings, preparedAt: new Date().toISOString() };
  await validateQaCorrectionAuthority(db, p);
  return { p, request };
}

/** DB-only acceptance. Receipt/queue/current readers, rather than a boolean wake return, justify waiting. */
async function queueIssued(db: Db, p: QaCorrectionPreparation, appliedEventId: string) {
  const proof = await readIssuedQaCorrection(db, { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId });
  for (const followup of proof.followups) {
    const t = followup.target, ref = { companyId: p.companyId, workflowRunId: p.workflowRunId,
      appliedEventId, requestId: followup.requestId };
    if (await readQaCorrectionFollowupConsumption(db, ref, readIssuedQaCorrection)) continue;
    const [issue] = await db.select().from(issues).where(eq(issues.id, t.issueId));
    const origin = p.authority.verdicts.find(v => v.qa.stepRunId === t.stepRunId);
    const [heartbeat] = origin ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, origin.heartbeatRunId)) : [];
    const agentId = issue?.assigneeAgentId ?? heartbeat?.agentId;
    requireQaCorrection(issue && agentId, "scope");
    const reason = "workflow_step_runnable", contextSnapshot = { issueId: t.issueId, taskId: t.issueId, taskKey: t.issueId,
      missionId: p.missionId, workflowRunId: p.workflowRunId, workflowStepRunId: t.stepRunId,
      stepId: t.stepId, workflowStepId: t.stepId, source: "workflow.resume", forceFreshSession: true, wakeReason: reason };
    const request = { source: "assignment", triggerDetail: "system", reason, requestKind: "workflow_resume",
      requestedByActorType: "system", requestedByActorId: "workflow:qa-remediation",
      idempotencyKey: qaCorrectionWakeKey(ref), contextSnapshot,
      payload: { issueId: t.issueId, mutation: "workflow_resume", missionId: p.missionId,
        workflowRunId: p.workflowRunId, workflowStepRunId: t.stepRunId, forceFreshSession: true, qaCorrectionFollowup: ref } };
    const input: CorrectionDeliveryInput = { mode: "initial", ref, companyId: p.companyId, agentId,
      issueId: t.issueId, missionId: p.missionId, workflowRunId: p.workflowRunId,
      workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration,
      candidateWakeupRequestId: null, request };
    if (await readQaCorrectionDelivery(db, input)) continue;
    await readQaCorrectionFollowupDb(db, ref, readIssuedQaCorrection);
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, p.companyId), eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey)));
    requireQaCorrection(wakes.length <= 1, "record");
    if (!wakes.length) {
      const { contextSnapshot: saved, ...r } = request;
      await insertWorkflowWakeRequest(db, { ...r, companyId: p.companyId, agentId, issueId: t.issueId,
        missionId: p.missionId, workflowRunId: p.workflowRunId, workflowStepRunId: t.stepRunId,
        workflowExecutionGeneration: t.executionGeneration, status: "queued",
        payload: { ...r.payload, _paperclipWakeContext: saved } });
    }
    await validateAndRegisterQaCorrectionRootDrain(db, input);
  }
}

export async function tryQaCorrectionFollowup(input: Input): Promise<QaRemediationPassResult | null> {
  const found = await discoverQaCorrection(input);
  if (!found) return null;
  const { db } = input, { p, request } = found;
  const [applied] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId), eq(workflowTransitionEvents.workflowRunId, p.workflowRunId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(p.correctionId))));
  if (!applied) throw new QaCorrectionReconcileRequired(request);
  await acceptIssued(db, p, applied.id);
  return { outcome: "waiting", detail: "issued correction followups have durable delivery or pending queue records" };
}

async function acceptIssued(db: Db, p: QaCorrectionPreparation, appliedEventId: string) {
  const request = requestFor(p);
  if (is(db, PgTransaction)) {
    if (!currentReplacementRootNotifications(db)) throw new QaCorrectionReconcileRequired(request);
    await queueIssued(db, p, appliedEventId);
  }
  else {
    const notifications = currentReplacementRootNotifications(db);
    // A direct legacy loop-driver caller has no owning root drain; never manufacture a waiting result.
    if (!notifications) throw new QaCorrectionReconcileRequired(request);
    await db.transaction(async tx => {
      await tx.select().from(missions).where(eq(missions.id, p.missionId)).for("no key update");
      await tx.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId)).for("no key update");
      await withReplacementRootNotificationDb(tx as unknown as Db, notifications,
        () => queueIssued(tx as unknown as Db, p, appliedEventId));
    });
  }
}

async function reconcile(db: Db, request: Request) {
  requireQaCorrection(!is(db, PgTransaction), "record");
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, request.runId));
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, request.runId));
  const producerRun = steps.find(s => s.id === request.producerStepRunId);
  const execution = await loadExecutionDefinition(db, request.runId, { requireHistorical: false });
  const producerStep = execution.steps.find(s => s.id === producerRun?.stepId);
  requireQaCorrection(run && producerRun && producerStep && run.status !== "cancelled", "scope");
  const backEdges = resolveEdges(producerStep).filter(e => e.isBackEdge && (e.maxIterations ?? 0) >= 1);
  requireQaCorrection(backEdges.length && producerRun.iterationIndex < Math.max(...backEdges.map(e => e.maxIterations!))
    + readCapBoostAmount(producerRun.metadata), "qualification");
  const rejectedQas = request.qaStepRunIds.map(id => {
    const qaRun = steps.find(s => s.id === id);
    requireQaCorrection(qaRun && backEdges.some(e => e.stepId === qaRun.stepId), "qualification");
    return { edge: { stepId: qaRun.stepId }, qaRun };
  });
  const findingsByQaStepId = new Map<string, readonly WorkflowVerdictFinding[] | null>();
  for (const q of rejectedQas) {
    const scope = { db, companyId: run.companyId, issueId: q.qaRun.issueId!,
      workflowRunId: run.id, workflowStepRunId: q.qaRun.id };
    const findings = await loadWorkflowApiFindings(scope);
    const prior = producerRun.completedAt
      ? await loadPriorRejectedFindings({ ...scope, notAfter: producerRun.completedAt }) : null;
    findingsByQaStepId.set(q.qaRun.stepId, findings ? applyRecurrencePromotion(findings, prior).findings : null);
  }
  const found = await discoverQaCorrection({ db, run, steps: execution.steps, producerStep, producerRun, rejectedQas, findingsByQaStepId });
  requireQaCorrection(found && same(found.request, request), "stale");
  const prepared = await beginQaCorrection(db, found.p);
  if (prepared.status === "already_applied") return;
  requireQaCorrection(prepared.status === "prepared" || prepared.status === "existing", "qualification");
  const measured = await measureQaCorrectionSources(db, {
    preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
  const committed = await commitQaCorrection(db, await storeQaCorrection(db, measured));
  requireQaCorrection(committed.status !== "stopped", "stale");
}

/** The transaction check applies to the supplied object itself; an external owner must unwind too. */
export async function withQaCorrectionFollowupReconcile<T>(db: Db, runId: string, sync: () => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) return sync();
  const notifications = createReplacementRootNotifications(), handled = new Set<string>();
  const execution = await loadExecutionDefinition(db, runId, { requireHistorical: false });
  const result = await withReplacementRootNotificationDb(db, notifications, async () => {
    for (let pass = 0; pass <= execution.steps.length + 1; pass++) {
      try { return await sync(); }
      catch (error) {
        if (!(error instanceof QaCorrectionReconcileRequired)) throw error;
        requireQaCorrection(error.request.runId === runId, "scope");
        const key = JSON.stringify(error.request);
        if (handled.has(key)) throw new QaCorrectionReadError("stale");
        handled.add(key);
        // withReplacementFirstDelivery has rolled back before this catch. No transaction object escapes.
        await reconcile(db, error.request);
      }
    }
    throw new QaCorrectionReadError("stale");
  });
  await drainReplacementRootNotifications(db, notifications);
  return result;
}
