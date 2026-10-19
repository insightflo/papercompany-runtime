import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, issues, missions, qualityActionGroups, qualityActions,
  qualityEvidenceRefs, qualityOccurrences, qualityPolicyVersions, qualityReviewItems,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import {
  nativeBindingSchema, qualityEffectSchema, qualityPolicySchema, qualityTargetSchema,
  retryEnvelopeSchema, workflowQaRemediationsSchema, workflowVerdictFindingsSchema,
} from "@paperclipai/shared";
import { HttpError } from "../../../errors.js";
import { hashContract, type QualityDb } from "../../quality/contract.js";
import { verifySourceAttempt } from "../../quality/evidence-verifier.js";
import { readPolicyUsageTotals } from "../../quality/policy-usage.js";
import { producerAttempt } from "../../work-products/producer-attempt.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY } from "../../heartbeat-finalization/workflow-attempt-proof.js";
import { readFrozenArtifactAttempt } from "../artifact-contract-runtime.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import { isDeliveryReadbackStep } from "../delivery-verification-gate.js";
import { loadLatestQaRemediations } from "../validation-verdict-ledger.js";
import { isLatestQaExecution } from "./qa-cap-acceptance.js";
import { isStructuralGateStep } from "./structural-gate.js";
import {
  hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionPreparationKey,
  type QaCorrectionAttempt, type QaCorrectionPreparation, type QaCorrectionVerdictAuthority,
} from "./qa-correction-contract.js";
import { readQaCorrectionSources, type QaCorrectionSourceRead } from "./qa-correction-reader.js";

export type QaCorrectionDb = QualityDb;
export type QaCorrectionFailureReason = "record" | "scope" | "attempt" | "verdict" | "heartbeat"
  | "stale" | "qualification" | "tool" | "quality" | "budget" | "source" | "binding" | "lineage" | "evidence";
export class QaCorrectionReadError extends Error {
  constructor(readonly reason: QaCorrectionFailureReason) { super(`qa_correction_${reason}`); }
}
export function requireQaCorrection(value: unknown, reason: QaCorrectionFailureReason): asserts value {
  if (!value) throw new QaCorrectionReadError(reason);
}

/** SELECT-only. Historical reads compare immutable logical identity, not today's attempt counters. */
export async function readQaCorrectionAttempt(db: QaCorrectionDb, p: QaCorrectionPreparation,
  attempt: QaCorrectionAttempt, current: boolean) {
  const [step] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, attempt.stepRunId), eq(workflowStepRuns.workflowRunId, p.workflowRunId)));
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.id, attempt.issueId), eq(issues.companyId, p.companyId)));
  requireQaCorrection(step && issue && step.stepId === attempt.stepId && step.issueId === issue.id
    && issue.missionId === p.missionId, "scope");
  if (current) {
    requireQaCorrection(step.executionGeneration === attempt.executionGeneration && step.retryCount === attempt.retryCount
      && step.iterationIndex === attempt.iterationIndex, "attempt");
    requireQaCorrection(!issue.hiddenAt && issue.status !== "cancelled", "scope");
  }
  return step;
}

export async function readQaCorrectionScope(db: QaCorrectionDb, p: QaCorrectionPreparation, current: boolean) {
  const [run] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, p.workflowRunId), eq(workflowRuns.companyId, p.companyId)));
  const [mission] = await db.select().from(missions).where(and(
    eq(missions.id, p.missionId), eq(missions.companyId, p.companyId)));
  requireQaCorrection(run && mission && run.missionId === mission.id, "scope");
  const producer = await readQaCorrectionAttempt(db, p, p.producer, current);
  if (current) {
    requireQaCorrection(run.dispatchAuthorityVersion === p.dispatchAuthorityVersion, "attempt");
    requireQaCorrection(run.status !== "cancelled" && mission.status !== "cancelled", "scope");
    requireQaCorrection(producer.status === "completed" && producer.completedAt, "qualification");
  }
  return { run, mission, producer };
}

/** An official event plus its real original wake is required, including for legacy NULL identities. */
export async function readQaCorrectionVerdict(db: QaCorrectionDb, p: QaCorrectionPreparation,
  v: QaCorrectionVerdictAuthority, current: boolean) {
  const qa = await readQaCorrectionAttempt(db, p, v.qa, current);
  requireQaCorrection(qa.id !== p.producer.stepRunId, "verdict");
  const [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, v.eventId));
  requireQaCorrection(event && event.companyId === p.companyId && event.missionId === p.missionId
    && event.workflowRunId === p.workflowRunId && event.workflowStepRunId === qa.id && event.issueId === v.qa.issueId
    && event.eventType === "workflow_validation_verdict" && event.reason === "workflow_api"
    && event.verdict === "request_changes" && event.heartbeatRunId === v.heartbeatRunId
    && (event.executionGeneration === null || event.executionGeneration === v.qa.executionGeneration), "verdict");
  const body = event.payload;
  requireQaCorrection(body.kind === "workflow_validation_verdict" && body.workflowRunId === p.workflowRunId
    && body.stepRunId === qa.id && body.issueId === v.qa.issueId && body.verdict === "request_changes", "verdict");
  const parsed = workflowQaRemediationsSchema.safeParse(body.remediations);
  requireQaCorrection(parsed.success && hashQaCorrectionPayload(parsed.data.items) === v.remediationsHash, "verdict");
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, v.heartbeatRunId));
  requireQaCorrection(heartbeat && heartbeat.companyId === p.companyId && heartbeat.issueId === v.qa.issueId
    && heartbeat.wakeupRequestId && (heartbeat.workflowStepRunId === null || heartbeat.workflowStepRunId === qa.id)
    && (heartbeat.workflowExecutionGeneration === null || heartbeat.workflowExecutionGeneration === v.qa.executionGeneration), "heartbeat");
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
  requireQaCorrection(wake && wake.companyId === p.companyId && wake.agentId === heartbeat.agentId
    && wake.workflowStepRunId === qa.id && (wake.issueId === null || wake.issueId === v.qa.issueId)
    && (wake.missionId === null || wake.missionId === p.missionId)
    && (wake.workflowRunId === null || wake.workflowRunId === p.workflowRunId)
    && (wake.workflowExecutionGeneration === null || wake.workflowExecutionGeneration === v.qa.executionGeneration)
    && (wake.runId === null || wake.runId === heartbeat.id)
    && (event.wakeupRequestId === null || event.wakeupRequestId === wake.id), "heartbeat");
  // Missing legacy proof stays missing. A present proof must pass the existing ancestry verifier.
  if (Object.hasOwn(wake.payload ?? {}, WORKFLOW_ATTEMPT_PROOF_KEY)) {
    try { await producerAttempt(db, heartbeat, { ...qa, ...v.qa, id: qa.id }); }
    catch (error) { if (!(error instanceof HttpError)) throw error; throw new QaCorrectionReadError("heartbeat"); }
  }
  return { qa, event, heartbeat, remediations: parsed.data };
}

export interface QaCorrectionQualityRead {
  action: typeof qualityActions.$inferSelect;
  group: typeof qualityActionGroups.$inferSelect;
  policy: typeof qualityPolicyVersions.$inferSelect;
  totals: Awaited<ReturnType<typeof readPolicyUsageTotals>> | null;
}

export interface QaCorrectionReservationProof { preparationEventId: string; preparationHash: string }

/** An event lookup/key alone is never a reservation proof. Shared with the prepare writer's history count. */
export function parseQaCorrectionPreparationRow(row: typeof workflowTransitionEvents.$inferSelect): QaCorrectionPreparation {
  let p: QaCorrectionPreparation;
  try { p = parseQaCorrectionEventPayload("qa_correction_prepared", row.payload); }
  catch { throw new QaCorrectionReadError("record"); }
  requireQaCorrection(row.id === p.correctionId && row.companyId === p.companyId && row.missionId === p.missionId
    && row.workflowRunId === p.workflowRunId && row.workflowStepRunId === p.producer.stepRunId
    && row.issueId === p.producer.issueId && row.executionGeneration === p.producer.executionGeneration
    && row.eventType === "qa_correction_prepared" && row.layer === "workflow_validation"
    && row.idempotencyKey === qaCorrectionPreparationKey(row.payload)
    && row.createdAt.getTime() === new Date(p.preparedAt).getTime(), "record");
  return p;
}
export async function readQaCorrectionReservation(db: QaCorrectionDb, p: QaCorrectionPreparation,
  proof: QaCorrectionReservationProof): Promise<void> {
  requireQaCorrection(proof && typeof proof === "object" && Object.keys(proof).length === 2
    && proof.preparationEventId === p.correctionId && /^[a-f0-9]{64}$/.test(proof.preparationHash), "record");
  const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, proof.preparationEventId));
  requireQaCorrection(row, "record");
  const stored = parseQaCorrectionPreparationRow(row);
  requireQaCorrection(stored.correctionId === p.correctionId && hashQaCorrectionPayload(row.payload) === proof.preparationHash
    && hashQaCorrectionPayload(row.payload) === hashQaCorrectionPayload(p), "record");
}

/** Historical checks use issuance time; later cancellation/policy replacement does not erase history. */
export async function readQaCorrectionQuality(db: QaCorrectionDb, p: QaCorrectionPreparation,
  current: boolean, issuedAt = new Date(p.preparedAt),
  reservation?: QaCorrectionReservationProof): Promise<QaCorrectionQualityRead | null> {
  if (reservation !== undefined) await readQaCorrectionReservation(db, p, reservation);
  const delta = reservation === undefined ? 1 : 0;
  const a = p.authority;
  if (a.kind !== "quality_current_output") return null;
  const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, p.companyId), eq(qualityActions.id, a.actionId)));
  const [group] = await db.select().from(qualityActionGroups).where(and(eq(qualityActionGroups.companyId, p.companyId), eq(qualityActionGroups.id, a.groupId)));
  const [policy] = await db.select().from(qualityPolicyVersions).where(and(eq(qualityPolicyVersions.companyId, p.companyId), eq(qualityPolicyVersions.id, a.policyVersionId)));
  requireQaCorrection(action && group && policy && action.kind === "current_output"
    && action.groupId === group.id && action.policyVersionId === policy.id && group.policyVersionId === policy.id
    && action.intentKey === a.intentKey, "quality");
  const target = qualityTargetSchema.safeParse(action.target), effect = qualityEffectSchema.safeParse(action.effect);
  const envelope = retryEnvelopeSchema.safeParse(action.retryEnvelope), binding = nativeBindingSchema.safeParse(action.canonicalBinding);
  const definition = qualityPolicySchema.safeParse(policy.definition);
  requireQaCorrection(target.success && target.data.kind === "current_output" && effect.success
    && effect.data.kind === "repair_supported_output" && envelope.success && binding.success && definition.success, "quality");
  requireQaCorrection(hashContract(target.data) === action.targetHash && action.targetHash === a.targetHash
    && hashContract(effect.data) === action.effectHash && action.effectHash === a.effectHash
    && hashContract(effect.data.target) === action.targetHash && hashContract(envelope.data) === a.retryEnvelopeHash
    && envelope.data.targetHash === a.targetHash && envelope.data.effectHash === a.effectHash
    && envelope.data.intentKey === a.intentKey && envelope.data.groupId === a.groupId
    && envelope.data.policyVersionId === a.policyVersionId && hashContract(target.data.source) === hashContract(a.source), "quality");
  const source = a.source, b = binding.data;
  requireQaCorrection(source.companyId === p.companyId && source.issueId === p.producer.issueId
    && source.mission.kind === "mission" && source.mission.id === p.missionId
    && source.workflow.kind === "workflow_step" && source.workflow.runId === p.workflowRunId
    && source.workflow.stepRunId === p.producer.stepRunId && source.workflow.generation === p.producer.executionGeneration
    && source.workflow.dispatchAuthorityVersion === p.dispatchAuthorityVersion
    && b.companyId === p.companyId && b.actionId === action.id && b.missionId === p.missionId
    && b.workflowRunId === p.workflowRunId && a.verdicts.some(v => v.qa.stepRunId === b.stepRunId
      && v.qa.issueId === b.issueId && v.heartbeatRunId === a.verifierRunId), "quality");
  const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.heartbeatRunId));
  const [verifier] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.verifierRunId));
  const verifierAttempt = a.verdicts.find(v => v.heartbeatRunId === a.verifierRunId)!.qa;
  requireQaCorrection(sourceRun && sourceRun.companyId === p.companyId && sourceRun.issueId === source.issueId
    && sourceRun.executionEpoch === source.executionEpoch && sourceRun.workflowStepRunId === p.producer.stepRunId
    && sourceRun.workflowExecutionGeneration === p.producer.executionGeneration
    && verifier && verifier.companyId === p.companyId && verifier.issueId === b.issueId
    && verifier.workflowStepRunId === b.stepRunId && verifier.workflowExecutionGeneration === verifierAttempt.executionGeneration
    && verifier.executionEpoch === a.verifierEpoch, "quality");
  const [review] = await db.select().from(qualityReviewItems).where(and(eq(qualityReviewItems.companyId, p.companyId), eq(qualityReviewItems.id, a.reviewItemId)));
  requireQaCorrection(review && action.occurrenceIds.length > 0, "quality");
  const occurrences = await db.select().from(qualityOccurrences).where(and(eq(qualityOccurrences.companyId, p.companyId),
    eq(qualityOccurrences.reviewItemId, a.reviewItemId), inArray(qualityOccurrences.id, action.occurrenceIds)));
  requireQaCorrection(occurrences.some(o => o.producerRunId === source.heartbeatRunId
    && hashContract(o.sourceBinding) === hashContract(source)), "quality");
  const now = current ? new Date() : issuedAt, rules = definition.data, budget = envelope.data;
  requireQaCorrection(policy.approvedAt && policy.enabledAt && policy.approvedAt <= now && policy.enabledAt <= now
    && (!policy.disabledAt || policy.disabledAt > now) && (!action.cancelRequestedAt || action.cancelRequestedAt > now)
    && now >= new Date(rules.periodStart) && now < new Date(rules.periodEnd) && now < new Date(budget.deadlineAt)
    && (!group.deadlineAt || now < group.deadlineAt) && rules.targets.every(t => t.companyId === p.companyId), "quality");
  let totals: QaCorrectionQualityRead["totals"] = null;
  if (current) {
    try { await verifySourceAttempt(db, p.companyId, source); }
    catch (error) { if (!(error instanceof HttpError)) throw error; throw new QaCorrectionReadError("quality"); }
    const scope = await readQaCorrectionScope(db, p, true);
    requireQaCorrection(!["completed", "cancelled"].includes(scope.mission.status)
      && !["completed", "cancelled", "aborted", "failed", "timed-out"].includes(scope.run.status ?? ""), "quality");
    totals = await readPolicyUsageTotals(db, { companyId: p.companyId, policyVersionId: policy.id,
      windowStart: new Date(rules.periodStart), windowEnd: new Date(rules.periodEnd) });
    const usage = (key: string) => {
      const value = group.usage[key] ?? 0;
      requireQaCorrection(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "budget");
      return value;
    };
    const [used] = await db.select({ n: count() }).from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, p.companyId), eq(qualityEvidenceRefs.qualityActionId, action.id),
      sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
    requireQaCorrection(Number(used?.n ?? 0) < budget.maxExecutorAttempts
      && totals.executionAttempts + delta <= budget.maxExecutorAttempts && usage("executionAttempts") + delta <= budget.maxExecutorAttempts
      && totals.reservedCostCents + totals.chargedCostCents <= rules.maxCostCentsPerPeriod
      && usage("reservedCostCents") + usage("chargedCostCents") <= budget.maxCumulativeCostCents, "budget");
  }
  return { action, group, policy, totals };
}

export interface QaCorrectionAuthorityRead {
  status: "authority_validated";
  preparation: QaCorrectionPreparation;
  sources: QaCorrectionSourceRead[];
  quality: QaCorrectionQualityRead | null;
  qualificationRequired: "collectQualifiableQaRemediations";
  finalizationRequired: "locked_recheck_and_reservation_cas";
}

/**
 * C03/C12: no file IO, reservation, event write or wake. The existing qualification caller still
 * owns sibling/back-edge eligibility, source-data/gate classification, patch validation and caps.
 * Prepare/commit rechecks under usage→group→action→policy→mission→run→heartbeat→issue→steps→products→bindings locks.
 */
export async function validateQaCorrectionAuthority(db: QaCorrectionDb, value: unknown,
  options?: { reservation?: QaCorrectionReservationProof }): Promise<QaCorrectionAuthorityRead> {
  let p: QaCorrectionPreparation;
  try { p = parseQaCorrectionEventPayload("qa_correction_prepared", value); }
  catch { throw new QaCorrectionReadError("record"); }
  const scope = await readQaCorrectionScope(db, p, true);
  const definition = await loadExecutionDefinition(db, p.workflowRunId, { requireHistorical: false });
  const facts = [];
  for (const v of p.authority.verdicts) {
    const fact = await readQaCorrectionVerdict(db, p, v, true);
    const loaded = await loadLatestQaRemediations({ db, companyId: p.companyId, issueId: v.qa.issueId });
    requireQaCorrection(loaded && loaded.sourceVerdictEventId === v.eventId && loaded.workflowStepRunId === v.qa.stepRunId
      && loaded.heartbeatRunId === v.heartbeatRunId && hashQaCorrectionPayload(loaded.remediations.items) === v.remediationsHash
      && loaded.observedAt && scope.producer.completedAt && loaded.observedAt >= scope.producer.completedAt, "stale");
    // The existing helper uses only SELECT; its older Db annotation also accepts our real transaction here.
    requireQaCorrection(await isLatestQaExecution(db as Db, v.qa.issueId, v.qa.stepRunId, v.heartbeatRunId), "stale");
    const step = definition.steps.find(s => s.id === v.qa.stepId);
    requireQaCorrection(step && step.capAcceptance !== "blocked" && !isStructuralGateStep(step) && !isDeliveryReadbackStep(step), "qualification");
    if (fact.event.payload.findings !== undefined) {
      const findings = workflowVerdictFindingsSchema.safeParse(fact.event.payload.findings);
      requireQaCorrection(findings.success && !findings.data.some(f => f.layer === "source_data"), "qualification");
    }
    facts.push(fact);
  }
  if (p.authority.kind === "workflow_qa" && p.authority.toolEvidence) {
    const proof = p.authority.toolEvidence;
    const matching = facts.filter(f => f.qa.lastDispatchRequestId === proof.requestId && f.qa.executionGeneration === proof.executionGeneration);
    requireQaCorrection(matching.length === 1, "tool");
    try {
      const frozen = readFrozenArtifactAttempt(matching[0]!.qa.metadata.artifactExecution, proof);
      requireQaCorrection(frozen.contract.role === "qa" && frozen.contractHash === proof.contractHash
        && frozen.qaConfigHash === proof.qaConfigHash, "tool");
    } catch { throw new QaCorrectionReadError("tool"); }
  }
  const quality = await readQaCorrectionQuality(db, p, true, undefined, options?.reservation);
  const sources = await readQaCorrectionSources(db, p, true);
  return { status: "authority_validated", preparation: p, sources, quality,
    qualificationRequired: "collectQualifiableQaRemediations", finalizationRequired: "locked_recheck_and_reservation_cas" };
}
