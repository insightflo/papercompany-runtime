import { isDeepStrictEqual as same } from "node:util";
import path from "node:path";
import { and, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { workProductProducerSchema } from "@paperclipai/shared";
import { loadConfig } from "../config.js";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, issueWorkProducts, missions,
  qualityActions, workflowRuns, workflowStepRuns, workflowStepOutputBindings, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import type { BudgetEnforcementScope } from "./budgets.js";
import { readWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { PAUSE_CONTROL_COLUMNS, pauseControlSchema, readPauseControl, type PauseReceipt } from "./heartbeat-pause-contract.js";
import { lockCurrentScope } from "./heartbeat-pause-intents.js";
import { readPauseControls } from "./heartbeat-pause-delivery.js";
import { readPauseChildProof } from "./heartbeat-pause-admission.js";
import { parseQualityWakeKey } from "./quality/native-wake.js";
import { lockQualityAttemptBudget, readQualityStepActionId } from "./quality/retry-budget.js";
import { freezeHeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";
import { resolveWorkProductLocalFilePath } from "./work-products/producer-seal.js";
import { hashQaCorrectionPayload } from "./workflow/control-flow/qa-correction-contract.js";
import { hashContract } from "./quality/contract.js";
import { readIssuedQaCorrectionFollowupForAttempt, type IssuedQaCorrection } from "./workflow/control-flow/qa-correction-reader.js";
import { createQaCorrectionHistorySession } from "./workflow/control-flow/qa-correction-history-session.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey } from "./workflow/control-flow/qa-remediation-completion.js";
import { validateQaRemediationCompletionEvidence, type QaRemediationCompletion } from "./workflow/control-flow/qa-remediation-completion-evidence.js";
import { qaRemediationQualityBindingHash } from "./workflow/control-flow/qa-remediation-quality-binding.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
  parseQaRemediationPreparation, type QaRemediationPreparation } from "./workflow/control-flow/qa-remediation-preparation-contract.js";
import { readQaRemediationPreparation } from "./workflow/control-flow/qa-remediation-preparation-reader.js";
import { createQaFileOwnerRuntime } from "./workflow/control-flow/qa-remediation-runtime.js";
import { loadLatestQaRemediations } from "./workflow/validation-verdict-ledger.js";

type Run = typeof heartbeatRuns.$inferSelect;
type StepRun = typeof workflowStepRuns.$inferSelect;
type WorkProduct = typeof issueWorkProducts.$inferSelect;
type ProducerProvenance = ReturnType<typeof workProductProducerSchema.parse>;
type ActualIdentity = NonNullable<Awaited<ReturnType<typeof freezeHeartbeatActualDrainIdentity>>>;
export type PauseInvalidationTarget = { kind: "run"; id: string } | { kind: "agent"; id: string }
  | { kind: "budget"; scope: BudgetEnforcementScope };
export type PauseInvalidationCause = "user_cancel" | "budget";
type StatusWriter = (tx: Db, id: string, status: string, patch: Partial<typeof heartbeatRuns.$inferInsert>,
  options: { expectedStatuses: string[]; deferLiveEvent: boolean }) => Promise<Run | null>;
const reject = (): never => { throw conflict("heartbeat_pause_invalidation_scope_changed"); };
const holdUnproven = (): never => { throw conflict("heartbeat_pause_revocation_scope_unproven"); };
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const active = (h: Run) => h.status === "queued" || h.status === "running";
const runIdentity = (h: Run) => [h.id, h.companyId, h.agentId, h.issueId, h.wakeupRequestId,
  h.workflowStepRunId, h.workflowExecutionGeneration, h.retryOfRunId, h.contextSnapshot, h.status,
  h.executionToken, h.executorOwnerId, h.executorOwnerLeaseEpoch, h.executorOwnerLeaseToken,
  h.resultJson, h.usageJson, h.sessionIdAfter];
const marker = (agentId: string) => and(eq(agentWakeupRequests.agentId, agentId), or(
  eq(agentWakeupRequests.source, PAUSE_CONTROL_COLUMNS.source),
  eq(agentWakeupRequests.requestedByActorId, PAUSE_CONTROL_COLUMNS.requestedByActorId)));
const attemptOf = (step: StepRun) => ({ stepRunId: step.id, stepId: step.stepId, issueId: step.issueId!,
  executionGeneration: step.executionGeneration, retryCount: step.retryCount, iterationIndex: step.iterationIndex });
const sameAttempt = (left: ReturnType<typeof attemptOf>, right: ReturnType<typeof attemptOf>) =>
  left.stepRunId === right.stepRunId && left.stepId === right.stepId && left.issueId === right.issueId
  && left.executionGeneration === right.executionGeneration && left.retryCount === right.retryCount
  && left.iterationIndex === right.iterationIndex;

type RevocationPreparation = {
  readonly row: typeof workflowTransitionEvents.$inferSelect;
  readonly preparation: QaRemediationPreparation;
  readonly completion: { readonly row: typeof workflowTransitionEvents.$inferSelect; readonly payload: QaRemediationCompletion } | null;
  readonly pending: boolean;
  readonly verdictHeartbeats: readonly Run[];
  readonly sourceFiles: readonly { readonly path: string; readonly product: WorkProduct;
    readonly producer: ProducerProvenance; readonly heartbeat: Run; readonly identity: ActualIdentity }[];
};

/** A pending target must remain bound to one current registered producer product and actual. */
async function readPendingSourceFiles(db: Db, preparation: QaRemediationPreparation): Promise<RevocationPreparation["sourceFiles"]> {
  const rows = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, preparation.companyId),
    eq(issueWorkProducts.issueId, preparation.producer.issueId), eq(issueWorkProducts.status, "active"),
  )).orderBy(issueWorkProducts.id);
  const sources: RevocationPreparation["sourceFiles"][number][] = [];
  for (const file of preparation.files) {
    if (!path.isAbsolute(file.path) || path.resolve(file.path) !== file.path) return holdUnproven();
    const matches = rows.filter(product => resolveWorkProductLocalFilePath(product) === file.path);
    if (matches.length !== 1) return holdUnproven();
    const product = matches[0]!;
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success || !product.createdByRunId || !["local", "local_file"].includes(product.provider)
      || product.createdAt > new Date(preparation.preparedAt)
      || product.sourceExecutionGeneration !== preparation.producer.executionGeneration) return holdUnproven();
    const producer = parsed.data, attempt = preparation.producer;
    if (product.companyId !== preparation.companyId || product.issueId !== attempt.issueId
      || producer.companyId !== preparation.companyId || producer.missionId !== preparation.missionId
      || producer.workflowRunId !== preparation.workflowRunId || producer.stepRunId !== attempt.stepRunId
      || producer.stepId !== attempt.stepId || producer.executionGeneration !== attempt.executionGeneration
      || producer.retryCount !== attempt.retryCount || producer.iterationIndex !== attempt.iterationIndex
      || producer.heartbeatRunId !== product.createdByRunId) return holdUnproven();
    const [heartbeat] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, producer.heartbeatRunId), eq(heartbeatRuns.companyId, preparation.companyId),
    ));
    if (!heartbeat || heartbeat.issueId !== attempt.issueId || heartbeat.workflowStepRunId !== attempt.stepRunId
      || heartbeat.workflowExecutionGeneration !== attempt.executionGeneration || !heartbeat.wakeupRequestId) return holdUnproven();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
    if (!wake || wake.runId !== heartbeat.id || wake.companyId !== preparation.companyId || wake.agentId !== heartbeat.agentId
      || wake.issueId !== attempt.issueId || wake.workflowRunId !== preparation.workflowRunId
      || wake.workflowStepRunId !== attempt.stepRunId || wake.workflowExecutionGeneration !== attempt.executionGeneration) return holdUnproven();
    let proof: ReturnType<typeof readWorkflowAttemptProof>, identity: ActualIdentity | null;
    try {
      proof = readWorkflowAttemptProof(wake);
      identity = await freezeHeartbeatActualDrainIdentity(db, heartbeat, { workflowRunId: preparation.workflowRunId });
    } catch { return holdUnproven(); }
    if (proof.workflowRunId !== preparation.workflowRunId || proof.missionId !== preparation.missionId
      || proof.stepRunId !== attempt.stepRunId || proof.issueId !== attempt.issueId
      || proof.executionGeneration !== attempt.executionGeneration || proof.retryCount !== attempt.retryCount
      || proof.iterationIndex !== attempt.iterationIndex || !identity || identity.companyId !== preparation.companyId
      || identity.missionId !== preparation.missionId || identity.workflowRunId !== preparation.workflowRunId
      || identity.workflowStepRunId !== attempt.stepRunId || identity.stepId !== attempt.stepId
      || identity.issueId !== attempt.issueId || identity.executionGeneration !== attempt.executionGeneration
      || identity.retryCount !== attempt.retryCount || identity.iterationIndex !== attempt.iterationIndex
      || identity.heartbeatRunId !== heartbeat.id || identity.wakeupRequestId !== wake.id) return holdUnproven();
    sources.push({ path: file.path, product, producer, heartbeat, identity });
  }
  if (new Set(sources.map(source => source.heartbeat.id)).size !== 1) return holdUnproven();
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

/** Exact current producer or QA reservations select native targets; a pending actual is not a drain veto. */
async function discoverRevocationPreparations(db: Db, targets: readonly Run[]): Promise<RevocationPreparation[]> {
  const stepIds = sorted(targets.flatMap(run => run.workflowStepRunId ? [run.workflowStepRunId] : []));
  if (!stepIds.length) return [];
  const selectedScopes = await db.select({ step: workflowStepRuns, workflow: workflowRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(inArray(workflowStepRuns.id, stepIds));
  if (selectedScopes.length !== stepIds.length || selectedScopes.some(({ step, workflow }) =>
    step.workflowRunId !== workflow.id || !targets.some(run => run.workflowStepRunId === step.id
      && run.companyId === workflow.companyId && run.issueId === step.issueId))) return holdUnproven();
  const workflowRunIds = sorted(selectedScopes.map(({ workflow }) => workflow.id));
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    inArray(workflowTransitionEvents.workflowRunId, workflowRunIds),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  )).orderBy(workflowTransitionEvents.id);
  const result: RevocationPreparation[] = [];
  for (const row of rows) {
    let preparation: QaRemediationPreparation;
    try { preparation = parseQaRemediationPreparation(row.payload); } catch { return holdUnproven(); }
    const p = preparation;
    const producerTargets = targets.filter(run => run.workflowStepRunId === p.producer.stepRunId);
    const qaTargets = targets.filter(run => p.verdicts.some(verdict => verdict.heartbeatRunId === run.id));
    if (!producerTargets.length && !qaTargets.length) continue;
    if (row.id !== p.preparationId || row.companyId !== p.companyId || row.missionId !== p.missionId
      || row.workflowRunId !== p.workflowRunId || row.workflowStepRunId !== p.producer.stepRunId
      || row.issueId !== p.producer.issueId || row.executionGeneration !== p.producer.executionGeneration
      || !workflowRunIds.includes(p.workflowRunId)) {
      return holdUnproven();
    }
    const [producerStep] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, p.producer.stepRunId), eq(workflowStepRuns.workflowRunId, p.workflowRunId),
    ));
    const [workflow] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    if (!producerStep || !workflow || workflow.companyId !== p.companyId
      || workflow.missionId !== p.missionId || workflow.dispatchAuthorityVersion !== p.dispatchAuthorityVersion
      || producerStep.workflowRunId !== p.workflowRunId || !sameAttempt(p.producer, attemptOf(producerStep))
      || producerStep.issueId !== p.producer.issueId) return holdUnproven();
    let sourceFiles: RevocationPreparation["sourceFiles"] = [];
    for (const verdict of p.verdicts) {
      const [qaStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, verdict.qa.stepRunId));
      const [qaHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
      if (!qaStep || !qaHeartbeat || qaStep.workflowRunId !== p.workflowRunId
        || !sameAttempt(verdict.qa, attemptOf(qaStep)) || qaHeartbeat.companyId !== p.companyId
        || qaHeartbeat.issueId !== verdict.qa.issueId || qaHeartbeat.workflowStepRunId !== verdict.qa.stepRunId
        || qaHeartbeat.workflowExecutionGeneration !== verdict.qa.executionGeneration || !qaHeartbeat.wakeupRequestId) {
        return holdUnproven();
      }
      const [qaWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaHeartbeat.wakeupRequestId));
      if (!qaWake || qaWake.runId !== qaHeartbeat.id || qaWake.companyId !== p.companyId
        || qaWake.agentId !== qaHeartbeat.agentId) return holdUnproven();
      let qaProof: ReturnType<typeof readWorkflowAttemptProof>;
      try { qaProof = readWorkflowAttemptProof(qaWake); } catch { return holdUnproven(); }
      if (qaProof.workflowRunId !== p.workflowRunId || qaProof.missionId !== p.missionId
        || qaProof.stepRunId !== verdict.qa.stepRunId || qaProof.issueId !== verdict.qa.issueId
        || qaProof.executionGeneration !== verdict.qa.executionGeneration
        || qaProof.retryCount !== verdict.qa.retryCount || qaProof.iterationIndex !== verdict.qa.iterationIndex) {
        return holdUnproven();
      }
      const selectedQa = targets.find(run => run.id === qaHeartbeat.id);
      if (selectedQa && !same(runIdentity(selectedQa), runIdentity(qaHeartbeat))) return holdUnproven();
      const latest = await loadLatestQaRemediations({ db, companyId: p.companyId, issueId: verdict.qa.issueId });
      if (!latest || latest.sourceVerdictEventId !== verdict.eventId || latest.heartbeatRunId !== verdict.heartbeatRunId
        || latest.workflowStepRunId !== verdict.qa.stepRunId
        || hashQaCorrectionPayload(latest.remediations.items) !== verdict.remediationsHash
        || !same(latest.remediations.items, verdict.items)) return holdUnproven();
    }
    const scope = {
      companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
      dispatchAuthorityVersion: workflow.dispatchAuthorityVersion, producer: attemptOf(producerStep), verdicts: p.verdicts,
      ...(p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
        ? { qualityBinding: { actionId: p.qualityBinding.actionId, bindingHash: qaRemediationQualityBindingHash(p.qualityBinding) } }
        : {}),
    };
    const history = await readQaRemediationPreparation(db, scope);
    if (history.status !== "prepared" || history.preparationEventId !== row.id
      || !history.preparation || !same(history.preparation, p)) return holdUnproven();
    const completionRows = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, p.companyId), eq(workflowTransitionEvents.workflowRunId, p.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, p.producer.stepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
    ));
    if (completionRows.length > 1) return holdUnproven();
    let completion: RevocationPreparation["completion"] = null;
    if (completionRows[0]) {
      const event = completionRows[0]!;
      if (event.idempotencyKey !== qaRemediationCompletionKey(p)) return holdUnproven();
      const validated = await validateQaRemediationCompletionEvidence(db, event, p);
      if (!validated.ok) return holdUnproven();
      completion = { row: event, payload: validated.completion };
    }
    const pending = completion === null;
    if (pending) sourceFiles = await readPendingSourceFiles(db, p);
    const sourceHeartbeat = sourceFiles[0]?.heartbeat ?? producerTargets[0];
    if (sourceHeartbeat) {
      if (producerTargets.some(target => target.issueId !== p.producer.issueId
        || target.workflowExecutionGeneration !== p.producer.executionGeneration)) return holdUnproven();
      if (producerTargets.some(target => !same(runIdentity(target), runIdentity(sourceHeartbeat)))) return holdUnproven();
      const [producerWake] = sourceHeartbeat.wakeupRequestId ? await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, sourceHeartbeat.wakeupRequestId)) : [];
      if (!producerWake || producerWake.runId !== sourceHeartbeat.id || producerWake.companyId !== p.companyId
        || producerWake.agentId !== sourceHeartbeat.agentId || producerWake.issueId !== p.producer.issueId
        || producerWake.workflowRunId !== p.workflowRunId || producerWake.workflowStepRunId !== p.producer.stepRunId
        || producerWake.workflowExecutionGeneration !== p.producer.executionGeneration) return holdUnproven();
      let producerProof: ReturnType<typeof readWorkflowAttemptProof>;
      try { producerProof = readWorkflowAttemptProof(producerWake); } catch { return holdUnproven(); }
      if (producerProof.workflowRunId !== p.workflowRunId || producerProof.missionId !== p.missionId
        || producerProof.stepRunId !== p.producer.stepRunId || producerProof.issueId !== p.producer.issueId
        || producerProof.executionGeneration !== p.producer.executionGeneration
        || producerProof.retryCount !== p.producer.retryCount || producerProof.iterationIndex !== p.producer.iterationIndex) return holdUnproven();
    } else if (producerTargets.length) return holdUnproven();
    const verdictHeartbeats: Run[] = [];
    for (const verdict of p.verdicts) {
      const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
      if (!heartbeat) return holdUnproven();
      verdictHeartbeats.push(heartbeat);
    }
    result.push({ row, preparation: p, completion, pending, verdictHeartbeats, sourceFiles });
  }
  return result.sort((a, b) => a.row.id.localeCompare(b.row.id));
}

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
  const revocationPreparations = await discoverRevocationPreparations(db,
    [...all.values()].filter(h => selected.has(h.id) && active(h)));
  for (const entry of revocationPreparations) for (const heartbeat of [
    ...entry.verdictHeartbeats, ...entry.sourceFiles.map(source => source.heartbeat),
  ]) {
    const prior = all.get(heartbeat.id);
    if (prior && !same(runIdentity(prior), runIdentity(heartbeat))) return reject();
    all.set(heartbeat.id, heartbeat);
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
  const remediationPreparations = revocationPreparations.map(entry => entry.preparation);
  const issueIds = sorted([...all.values()].flatMap(h => h.issueId ? [h.issueId] : []).concat(
    targets.map(t => t.issueId), remediationPreparations.flatMap(p => [
      p.producer.issueId, ...p.verdicts.map(v => v.qa.issueId),
    ])));
  const issueRows = issueIds.length ? await db.select().from(issues).where(inArray(issues.id, issueIds)).orderBy(issues.id) : [];
  const stepIds = sorted([...all.values(), ...wakes.values()].flatMap(h => h.workflowStepRunId ? [h.workflowStepRunId] : [])
    .concat(targets.map(t => t.stepRunId), remediationPreparations.flatMap(p => [
      p.producer.stepRunId, ...p.verdicts.map(v => v.qa.stepRunId),
    ])));
  const steps = stepIds.length ? await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.id, stepIds)) : [];
  const runIds = sorted([...wakes.values()].flatMap(w => w.workflowRunId ? [w.workflowRunId] : [])
    .concat(steps.map(s => s.workflowRunId), preparations.map(p => p.workflowRunId),
      remediationPreparations.map(p => p.workflowRunId),
      issueRows.flatMap(i => i.originKind === "workflow_execution" && i.originRunId ? [i.originRunId] : [])));
  const workflows = runIds.length ? await db.select().from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  if (workflows.some(w => w.companyId !== companyId) || issueRows.some(i => i.companyId !== companyId)) return reject();
  const actionIds = sorted([...steps.flatMap(s => { const id = readQualityStepActionId(s.metadata); return id ? [id] : []; }),
    ...[...wakes.values()].flatMap(w => { const key = parseQualityWakeKey(w.idempotencyKey); return key ? [key.actionId] : []; }),
    ...preparations.flatMap(p => p.authority.kind === "quality_current_output" ? [p.authority.actionId] : []),
    ...remediationPreparations.flatMap(p => p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
      ? [p.qualityBinding.actionId] : [])]);
  const actions = actionIds.length ? await db.select({ id: qualityActions.id, companyId: qualityActions.companyId,
    groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId, intentKey: qualityActions.intentKey,
    targetHash: qualityActions.targetHash, effectHash: qualityActions.effectHash, retryEnvelope: qualityActions.retryEnvelope,
    canonicalBinding: qualityActions.canonicalBinding }).from(qualityActions)
    .where(inArray(qualityActions.id, actionIds)).orderBy(qualityActions.policyVersionId, qualityActions.groupId, qualityActions.id) : [];
  if (actions.length !== actionIds.length || actions.some(a => a.companyId !== companyId)) return reject();
  for (const p of remediationPreparations) if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
    const action = actions.find(a => a.id === p.qualityBinding.actionId);
    if (!action || action.groupId !== p.qualityBinding.groupId
      || action.policyVersionId !== p.qualityBinding.policyVersionId || action.intentKey !== p.qualityBinding.intentKey
      || action.targetHash !== p.qualityBinding.targetHash || action.effectHash !== p.qualityBinding.effectHash
      || hashContract(action.retryEnvelope) !== p.qualityBinding.retryEnvelopeHash
      || !same(action.canonicalBinding, p.qualityBinding.canonicalBinding)) return holdUnproven();
  }
  const heartbeatIds = sorted([...all.keys(), ...preparations.flatMap(p => [
    ...p.authority.verdicts.map(v => v.heartbeatRunId),
    ...p.sources.flatMap(s => s.provenance.kind === "workflow_producer" ? [s.provenance.workflowProducer.heartbeatRunId] : []),
    ...(p.authority.kind === "quality_current_output" ? [p.authority.source.heartbeatRunId, p.authority.verifierRunId] : [])]),
    ...remediationPreparations.flatMap(p => p.verdicts.map(v => v.heartbeatRunId)),
    ...issueRows.flatMap(i => [i.executionRunId, i.checkoutRunId].filter((id): id is string => !!id))]);
  const heartbeatRows = [...all.values()];
  if (heartbeatRows.some(h => h.companyId !== companyId)) return reject();
  const products = sorted([...history.flatMap(h => [...h.preparation.sources.map(s => s.productId), ...h.applied.revisions.map(r => r.workProductId)]),
    ...revocationPreparations.flatMap(entry => entry.sourceFiles.map(source => source.product.id))]);
  const bindings = sorted(preparations.flatMap(p => p.bindings.map(b => b.bindingId)));
  const missionIds = sorted([...records.flatMap(p => p.kind === "receipt" && p.identity.missionId ? [p.identity.missionId] : []),
    ...workflows.flatMap(w => w.missionId ? [w.missionId] : []), ...[...wakes.values()].flatMap(w => w.missionId ? [w.missionId] : []),
    ...remediationPreparations.map(p => p.missionId)]);
  const missionRows = missionIds.length ? await db.select().from(missions).where(inArray(missions.id, missionIds)).orderBy(missions.id) : [];
  if (missionRows.some(m => m.companyId !== companyId)) return reject();
  const productRows = products.length ? await db.select().from(issueWorkProducts)
    .where(inArray(issueWorkProducts.id, products)).orderBy(issueWorkProducts.id) : [];
  const bindingRows = bindings.length ? await db.select().from(workflowStepOutputBindings)
    .where(inArray(workflowStepOutputBindings.id, bindings)).orderBy(workflowStepOutputBindings.id) : [];
  if (productRows.length !== products.length || bindingRows.length !== bindings.length) return reject();
  const nativeTargets = sorted(revocationPreparations.flatMap(entry => entry.pending
    ? entry.preparation.files.map(file => file.path) : []));
  return { requested, companyId, selectedAgents, records, receipts, chosen: sorted([...chosen]),
    targets: [...all.values()].filter(h => selected.has(h.id) && active(h)).sort((a, b) => a.id.localeCompare(b.id)),
    pending, all: [...all.values()].sort((a, b) => a.id.localeCompare(b.id)), wakes: [...wakes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    actions, heartbeatIds, issueIds, stepIds, runIds, missionIds, products, bindings, issueRows, steps, workflows,
    missionRows, productRows, bindingRows, revocationPreparations, nativeTargets };
}
type Observation = Awaited<ReturnType<typeof observe>>;
export type PauseInvalidationObservation = Observation;
function footprint(o: Observation) {
  return { companyId: o.companyId, agents: o.selectedAgents,
    records: o.records, chosen: o.chosen, targets: o.targets.map(runIdentity), all: o.all.map(runIdentity),
    wakes: o.wakes, pending: o.pending, actions: o.actions, heartbeatIds: o.heartbeatIds, issueIds: o.issueIds,
    stepIds: o.stepIds, runIds: o.runIds, missionIds: o.missionIds, products: o.products, bindings: o.bindings,
    owners: o.issueRows, steps: o.steps, workflows: o.workflows, missions: o.missionRows,
    productRows: o.productRows, bindingRows: o.bindingRows, revocationPreparations: o.revocationPreparations,
    nativeTargets: o.nativeTargets };
}

async function ownsFirstPauseHeadInitialization(connection: Db, initial: Observation, fresh: Observation,
  target: PauseInvalidationTarget, transactionId: string): Promise<string | null> {
  if (target.kind !== "agent" || !/^[1-9][0-9]*$/.test(transactionId) || initial.records.length !== 0
    || fresh.records.length !== 1) return null;
  const [head] = fresh.records;
  if (!head || head.kind !== "head" || head.agentId !== target.id || head.companyId !== fresh.companyId || head.scopeId !== null) return null;
  const [row] = await connection.execute(sql`
    SELECT txid_current()::text AS transaction_id, xmin::text AS row_transaction_id
    FROM ${agentWakeupRequests} WHERE ${agentWakeupRequests.id} = ${head.id}
  `);
  return row?.transaction_id === transactionId && row?.row_transaction_id === transactionId ? head.id : null;
}

/** The native owner spans exactly one original transaction and is positively closed before caller signals. */
export async function withPauseInvalidationOwner<T>(
  db: Db,
  target: PauseInvalidationTarget,
  work: (initial: Observation, revalidate: (connection: Db, firstHeadTransactionId?: string) => Promise<Observation>) => Promise<T>,
): Promise<T> {
  if (is(db, PgTransaction)) throw conflict("heartbeat_cancellation_root_required");
  const initial = await observe(db, target);
  let owner: Awaited<ReturnType<ReturnType<typeof createQaFileOwnerRuntime>["begin"]>> | null = null;
  if (initial.nativeTargets.length) {
    try { owner = await createQaFileOwnerRuntime(loadConfig()).begin(initial.nativeTargets); }
    catch { return holdUnproven(); }
  }
  let value!: T, failed = false, failure: unknown;
  try {
    value = await work(initial, async (connection, firstHeadTransactionId) => {
      const fresh = await observe(connection, target);
      if (!same(footprint(initial), footprint(fresh))) {
        const localHeadId = firstHeadTransactionId
          ? await ownsFirstPauseHeadInitialization(connection, initial, fresh, target, firstHeadTransactionId) : null;
        if (!localHeadId || !same(footprint(initial), footprint({
          ...fresh, records: fresh.records.filter(record => record.id !== localHeadId),
        }))) return reject();
      }
      return fresh;
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (owner) {
    let exit: Awaited<ReturnType<typeof owner.close>>;
    try { exit = await owner.close(); } catch { return holdUnproven(); }
    if (!exit || exit.code !== 0 || exit.signal !== null) return holdUnproven();
  }
  if (failed) throw failure;
  return value;
}

/** Own the actual commit: a savepoint cannot authorize signals or queue progress. */
export async function commitPauseInvalidation(db: Db, target: PauseInvalidationTarget,
  cause: PauseInvalidationCause, reason: string, setStatus: StatusWriter) {
  if (is(db, PgTransaction)) throw conflict("heartbeat_cancellation_root_required");
  return withPauseInvalidationOwner(db, target, (initial, revalidate) => db.transaction(async tx => {
    const t = tx as unknown as Db, o = await observe(t, target);
    if (!same(footprint(initial), footprint(o))) return reject();
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
    const fresh = await revalidate(t);
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
  }));
}
