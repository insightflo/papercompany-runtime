/** Quality correction: C03 issuance/consumption first; non-C03 current_output converges on E. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { and, desc, eq, is, sql, or, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { PgTransaction } from "drizzle-orm/pg-core";
import {
  workflowRecoveryAuthorities,
  agentWakeupRequests,
  heartbeatRuns,
  qualityActions,
  qualityEvidenceRefs,
  qualityOccurrences,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  outputCorrectionScopeSchema,
  qualityEffectSchema,
  qualityKeySchema,
  retryEnvelopeSchema,
  qualityTargetSchema,
  type QualityKey,
  type SourceAttempt,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../../errors.js";
import { insertActivityRecord } from "../activity-log-records.js";
import { hashContract, parseEvidence, evidenceContractSchema } from "./contract.js";
import { ensureCanonicalQualityExecution } from "./native-records.js";
import { discoverQaCorrection } from "../workflow/control-flow/qa-correction-followup-reconcile.js";
import { parseQaCorrectionPreparationRow, requireQaCorrection } from "../workflow/control-flow/qa-correction-authority.js";
import { beginQaCorrection } from "../workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../workflow/control-flow/qa-correction-commit.js";
import { readIssuedQaCorrection, type IssuedQaCorrection } from "../workflow/control-flow/qa-correction-reader.js";
import { readQaCorrectionFollowupDb, readQaCorrectionFollowupConsumption } from "../workflow/control-flow/qa-correction-followup.js";
import type { QaCorrectionPreparation } from "../workflow/control-flow/qa-correction-contract.js";
import { loadConfig } from "../../config.js";
import {
  QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3,
  parseQaRemediationCompletion,
  qaRemediationCompletionKey,
  qaRemediationRefireV2WakeKey,
  validateQaRemediationCompletionEvidence,
} from "../workflow/control-flow/qa-remediation-completion-evidence.js";
import {
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
  parseQaRemediationPreparation,
  qaRemediationPreparationKey,
} from "../workflow/control-flow/qa-remediation-preparation-contract.js";
import {
  reconcileQaRemediationReservation,
  QaRemediationReconcileError,
} from "../workflow/control-flow/qa-remediation-reconcile.js";
import { createQaFileOwnerRuntime } from "../workflow/control-flow/qa-remediation-runtime.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "../workflow/replacement-agent-delivery.js";
import { collectQualifiableQaRemediations } from "../workflow/control-flow/qa-remediation.js";
import { normalizeWorkflowStepsForExecution } from "../workflow/dag-engine.js";
import { loadWorkflowApiFindings } from "../workflow/validation-verdict-ledger.js";
import type { EdgeBearingStep } from "../workflow/control-flow/edge-condition.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";

import { getStorageService } from "../../storage/index.js";
import { linkEvidence, uploadEvidence } from "./evidence-store.js";
import type { TryQaRemediationInput, QualifiedQa, PreparedFile } from "../workflow/control-flow/qa-remediation-contract.js";
import { remediationIdempotencyKey, QA_REMEDIATION_EVENT_TYPE } from "../workflow/control-flow/qa-remediation-contract.js";
import { computeDefectSignature } from "../workflow/control-flow/knowledge-draft-capture.js";
import { hasPendingQaRemediationForRun } from "../workflow/control-flow/qa-remediation-admission-root.js";

export type CurrentOutputRemediationOutcome =
  | {
      readonly outcome: "completed";
      readonly schemaVersion: typeof QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3;
      readonly preparationId: string;
      readonly completionEventId: string;
      readonly qualityUseEvidenceRefId: string;
      readonly wakeupRequestIds: readonly string[];
      readonly canonicalWakeupRequestId: string;
      readonly canonicalStepRunId: string;
      readonly canonicalIssueId: string;
    }
  | { readonly outcome: "not_applicable"; readonly detail: string }
  | {
      readonly outcome: "held" | "partial" | "unknown";
      readonly reason: string;
      readonly detail: string;
      readonly files?: readonly { readonly file: string; readonly status: string; readonly detail: string }[];
      readonly completionEventId?: string;
      readonly qualityUseEvidenceRefId?: string;
      readonly wakeupRequestIds?: readonly string[];
    };

export type CurrentOutputCorrectionStatus =
  | { status: "verification_pending"; evidenceRefId: string | null; remediation?: CurrentOutputRemediationOutcome }
  | { status: "unsupported_target"; evidenceRefId: null; remediation?: CurrentOutputRemediationOutcome }
  | { status: "source_preserved"; evidenceRefId: null };

const UNSUPPORTED: CurrentOutputCorrectionStatus = { status: "unsupported_target", evidenceRefId: null };

type ActionRow = typeof qualityActions.$inferSelect;
type CurrentOutputEPreparation = Extract<ReturnType<typeof parseQaRemediationPreparation>,
  { schemaVersion: typeof QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 }>;
type CurrentOutputECompletion = Extract<ReturnType<typeof parseQaRemediationCompletion>,
  { schemaVersion: typeof QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3 }>;
type CurrentOutputEReaderDb = Pick<Db, "select">;

type CurrentOutputEHistory =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | { kind: "exact"; preparation: CurrentOutputEPreparation };

type CurrentOutputEAdmissionEvidence = {
  preparation: CurrentOutputEPreparation;
  completion: CurrentOutputECompletion;
  completionEvent: typeof workflowTransitionEvents.$inferSelect;
  wake: typeof agentWakeupRequests.$inferSelect;
  wakeupRequestId: string;
};

export type CurrentOutputEAdmission =
  | { kind: "none" }
  | { kind: "held"; reason: string; detail: string; preparationId?: string; completionEventId?: string;
      wakeupRequestId?: string; actualId?: string }
  | (CurrentOutputEAdmissionEvidence & { kind: "pending"; actual: null })
  | (CurrentOutputEAdmissionEvidence & { kind: "admitted"; actual: typeof heartbeatRuns.$inferSelect });

/** Read the frozen E completion and its committed wake/run admission without acquiring authority or writing. */
export async function readCurrentOutputEAdmission(
  db: CurrentOutputEReaderDb,
  key: QualityKey,
  loadedAction?: ActionRow,
): Promise<CurrentOutputEAdmission> {
  const parsed = parseEvidence(qualityKeySchema, key);
  let action = loadedAction;
  if (!action) {
    const [stored] = await db.select().from(qualityActions).where(and(
      eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
    action = stored;
  }
  if (!action || action.companyId !== parsed.companyId || action.id !== parsed.actionId) {
    return { kind: "held", reason: "action_missing", detail: "the exact Quality action is unavailable for E admission" };
  }
  if (action.kind !== "current_output") return { kind: "none" };

  const target = qualityTargetSchema.safeParse(action.target);
  const effect = qualityEffectSchema.safeParse(action.effect);
  const envelope = retryEnvelopeSchema.safeParse(action.retryEnvelope);
  if (!target.success || target.data.kind !== "current_output" || !effect.success
    || effect.data.kind !== "repair_supported_output" || !envelope.success
    || hashContract(target.data) !== action.targetHash || hashContract(effect.data) !== action.effectHash
    || envelope.data.targetHash !== action.targetHash || envelope.data.effectHash !== action.effectHash) {
    return { kind: "held", reason: "action_binding_invalid", detail: "current Quality target/effect hashes do not bind E history" };
  }

  const history = await readCurrentOutputEHistory(db, parsed.companyId, action, target.data.source);
  if (history.kind === "none") return { kind: "none" };
  if (history.kind === "invalid") return { kind: "held", reason: "invalid_history", detail: history.detail };
  const preparation = history.preparation;
  const binding = preparation.qualityBinding.canonicalBinding;
  if (!action.canonicalBinding || hashContract(action.canonicalBinding) !== hashContract(binding)) {
    return { kind: "held", reason: "canonical_binding_mismatch", detail: "stored action binding differs from the frozen v3 QA binding",
      preparationId: preparation.preparationId };
  }

  const completionRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, preparation.companyId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation))));
  if (completionRows.length !== 1) {
    return { kind: "held", reason: "completion_missing_or_ambiguous",
      detail: `expected one exact E completion row, found ${completionRows.length}`,
      preparationId: preparation.preparationId };
  }
  const completionEvent = completionRows[0]!;
  const validated = await validateQaRemediationCompletionEvidence(db as unknown as Db, completionEvent, preparation);
  if (!validated.ok || validated.completion.schemaVersion !== QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3) {
    return { kind: "held", reason: validated.ok ? "completion_version_mismatch" : validated.reason,
      detail: validated.ok ? "E completion is not strict v3" : validated.detail,
      preparationId: preparation.preparationId, completionEventId: completionEvent.id };
  }
  const completion = validated.completion;
  const canonicalWakes = completion.wakes.filter((wake) =>
    wake.stepRunId === binding.stepRunId && wake.issueId === binding.issueId);
  if (completion.wakes.length !== 1 || canonicalWakes.length !== 1) {
    return { kind: "held", reason: "canonical_wake_ambiguous",
      detail: "strict v3 E completion does not contain exactly one wake for the frozen canonical QA issue/step",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id };
  }
  const completionWake = canonicalWakes[0]!;
  const verdict = preparation.verdicts.find((candidate) => candidate.eventId === completionWake.sourceVerdictEventId
    && candidate.qa.issueId === binding.issueId && candidate.qa.stepRunId === binding.stepRunId);
  if (!verdict || completionWake.stepId !== verdict.qa.stepId
    || completionWake.executionGeneration !== verdict.qa.executionGeneration) {
    return { kind: "held", reason: "source_verdict_mismatch",
      detail: "E completion wake is not bound to the frozen QA verdict tuple",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: completionWake.wakeupRequestId };
  }

  const wakeRows = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, preparation.companyId),
    eq(agentWakeupRequests.id, completionWake.wakeupRequestId)));
  if (wakeRows.length !== 1) {
    return { kind: "held", reason: "wake_missing_or_ambiguous",
      detail: `expected one stored E wake, found ${wakeRows.length}`,
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: completionWake.wakeupRequestId };
  }
  const wake = wakeRows[0]!;
  const expectedWakeKey = qaRemediationRefireV2WakeKey(preparation, verdict.qa.stepRunId, verdict.eventId);
  const payload = wake.payload && typeof wake.payload === "object" && !Array.isArray(wake.payload)
    ? wake.payload as Record<string, unknown> : null;
  const pointer = payload?.qaRemediationCompletion;
  const pointerRecord = pointer && typeof pointer === "object" && !Array.isArray(pointer)
    ? pointer as Record<string, unknown> : null;
  let proof: ReturnType<typeof readWorkflowAttemptProof>;
  try { proof = readWorkflowAttemptProof(wake); }
  catch {
    return { kind: "held", reason: "wake_attempt_proof_invalid",
      detail: "reserved workflow-attempt proof is missing, malformed, or mismatched",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: wake.id };
  }
  if (wake.requestKind !== "workflow_resume" || wake.id !== completionWake.wakeupRequestId
    || wake.idempotencyKey !== completionWake.idempotencyKey || wake.idempotencyKey !== expectedWakeKey
    || wake.companyId !== preparation.companyId || wake.missionId !== preparation.missionId
    || wake.workflowRunId !== preparation.workflowRunId || wake.issueId !== verdict.qa.issueId
    || wake.workflowStepRunId !== verdict.qa.stepRunId
    || wake.workflowExecutionGeneration !== verdict.qa.executionGeneration
    || wake.agentId !== completionWake.agentId || completionWake.issueId !== verdict.qa.issueId
    || completionWake.stepRunId !== verdict.qa.stepRunId || completionWake.sourceVerdictEventId !== verdict.eventId
    || !pointerRecord
    || pointerRecord?.preparationEventId !== preparation.preparationId
    || pointerRecord?.sourceVerdictEventId !== verdict.eventId
    || proof.companyId !== preparation.companyId || proof.missionId !== preparation.missionId
    || proof.workflowRunId !== preparation.workflowRunId || proof.issueId !== verdict.qa.issueId
    || proof.stepRunId !== verdict.qa.stepRunId || proof.executionGeneration !== verdict.qa.executionGeneration
    || proof.retryCount !== verdict.qa.retryCount || proof.iterationIndex !== verdict.qa.iterationIndex) {
    return { kind: "held", reason: "wake_binding_mismatch",
      detail: "stored E wake, completion receipt, reserved pointer, and original attempt proof do not agree",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: wake.id };
  }

  const actuals = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, preparation.companyId), eq(heartbeatRuns.wakeupRequestId, wake.id)));
  const evidence: CurrentOutputEAdmissionEvidence = {
    preparation, completion, completionEvent, wake, wakeupRequestId: wake.id,
  };
  if (actuals.length === 0) {
    if (wake.runId === null && ["queued", "deferred_issue_execution"].includes(wake.status)) {
      return { kind: "pending", ...evidence, actual: null };
    }
    return { kind: "held", reason: "actual_missing_after_admission",
      detail: "E wake is not positively pending and has no reciprocal heartbeat actual",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: wake.id };
  }
  if (actuals.length !== 1) {
    return { kind: "held", reason: "multiple_actuals",
      detail: `expected one heartbeat for the exact E wake, found ${actuals.length}`,
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: wake.id };
  }
  const actual = actuals[0]!;
  const context = actual.contextSnapshot && typeof actual.contextSnapshot === "object" && !Array.isArray(actual.contextSnapshot)
    ? actual.contextSnapshot as Record<string, unknown> : null;
  const expectedScope: Record<string, unknown> = {
    companyId: preparation.companyId, missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
    workflowStepRunId: verdict.qa.stepRunId, issueId: verdict.qa.issueId,
    executionGeneration: verdict.qa.executionGeneration, workflowExecutionGeneration: verdict.qa.executionGeneration,
  };
  const contextScopeMatches = context !== null || actual.contextSnapshot === null
    ? Object.entries(expectedScope).every(([name, value]) => context?.[name] == null || context[name] === value)
    : false;
  const scopeMatches = (actual.workflowStepRunId === null || actual.workflowStepRunId === verdict.qa.stepRunId)
    && (actual.workflowExecutionGeneration === null || actual.workflowExecutionGeneration === verdict.qa.executionGeneration)
    && (actual.executionScopeKind === null || actual.executionScopeKind === "workflow_step")
    && contextScopeMatches;
  const started = actual.status !== "queued" || actual.startedAt !== null || actual.executionEpoch !== null;
  const validEpoch = actual.executionEpoch === null
    || (Number.isSafeInteger(actual.executionEpoch) && actual.executionEpoch >= 0);
  if (wake.runId !== actual.id || actual.wakeupRequestId !== wake.id || actual.companyId !== preparation.companyId
    || actual.agentId !== wake.agentId || actual.issueId !== verdict.qa.issueId
    || proof.parentHeartbeatRunId !== actual.retryOfRunId || !scopeMatches || !validEpoch
    || (started && (actual.workflowStepRunId !== verdict.qa.stepRunId
      || actual.workflowExecutionGeneration !== verdict.qa.executionGeneration
      || actual.executionEpoch === null || !actual.startedAt
      || actual.startedAt.getTime() < wake.requestedAt.getTime()))) {
    return { kind: "held", reason: "reciprocal_actual_mismatch",
      detail: "E heartbeat does not match the committed wake, frozen QA attempt, or started workflow scope",
      preparationId: preparation.preparationId, completionEventId: completionEvent.id,
      wakeupRequestId: wake.id, actualId: actual.id };
  }
  return { kind: "admitted", ...evidence, actual };
}

export async function applyCurrentOutputCorrection(db: Db, key: QualityKey): Promise<CurrentOutputCorrectionStatus> {
  if (is(db, PgTransaction)) throw new QaRemediationReconcileError("nested_caller");
  const parsed = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  if (action.kind !== "current_output") return UNSUPPORTED;
  const target = qualityTargetSchema.safeParse(action.target);
  const effect = qualityEffectSchema.safeParse(action.effect);
  const envelope = retryEnvelopeSchema.safeParse(action.retryEnvelope);
  if (!target.success || target.data.kind !== "current_output" || !effect.success || effect.data.kind !== "repair_supported_output" || !envelope.success) return UNSUPPORTED;
  if (hashContract(target.data) !== action.targetHash || hashContract(effect.data) !== action.effectHash
    || envelope.data.targetHash !== action.targetHash || envelope.data.effectHash !== action.effectHash) return UNSUPPORTED;
  const source = target.data.source;
  const history = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, parsed.companyId), eq(workflowTransitionEvents.eventType, "qa_correction_prepared"),
    sql`${workflowTransitionEvents.payload}->'authority'->>'actionId' = ${action.id}`));
  for (const row of history) {
    const p = parseQaCorrectionPreparationRow(row);
    requireQaCorrection(p.authority.kind === "quality_current_output" && p.authority.actionId === action.id
      && hashContract(p.authority.source) === hashContract(source), "quality");
    return issueQualityCorrection(db, p);
  }

  // A strict v3 reservation carries the frozen source and canonical QA identity.
  // Let E recognize its exact committed completion before live source admission:
  // legitimate QA completion can terminalize the source run after publication.
  const historical = await readCurrentOutputEHistory(db, parsed.companyId, action, source);
  if (historical.kind === "invalid") return invalidEHistory(historical.detail);
  if (historical.kind === "exact") {
    const preparation = historical.preparation;
    if (!action.canonicalBinding || hashContract(action.canonicalBinding) !== hashContract(preparation.qualityBinding.canonicalBinding)) {
      return invalidEHistory("stored action canonical binding differs from the frozen v3 Quality binding");
    }
    return reconcileCurrentOutputE(db, {
      key: parsed,
      actionId: action.id,
      source: preparation.qualityBinding.source,
      binding: preparation.qualityBinding.canonicalBinding,
      request: requestFromQualityPreparation(preparation),
    });
  }
  if (action.cancelRequestedAt) return UNSUPPORTED;
  if (Date.now() >= Date.parse(envelope.data.deadlineAt)) return UNSUPPORTED;

  // 정식 실행·producer/QA binding 확인(원자 binding). terminal 원본은 원본 유지로 거절된다.
  let binding;
  try {
    binding = await ensureCanonicalQualityExecution(db, parsed);
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.message === "quality_source_preserved") return { status: "source_preserved", evidenceRefId: null };
      return UNSUPPORTED;
    }
    throw error;
  }

  if (source.mission.kind !== "mission" || source.workflow.kind !== "workflow_step") return UNSUPPORTED;
  if (!await currentOutputHasC5Scope(db, parsed.companyId, source.workflow.runId))
    return applyLegacyCurrentOutput(db, { key: parsed, action, source, binding, envelope: envelope.data });
  const refreshedHistory = await readCurrentOutputEHistory(db, parsed.companyId, action, source);
  if (refreshedHistory.kind === "invalid") return invalidEHistory(refreshedHistory.detail);
  if (refreshedHistory.kind === "exact") {
    const preparation = refreshedHistory.preparation;
    if (!action.canonicalBinding || hashContract(action.canonicalBinding) !== hashContract(preparation.qualityBinding.canonicalBinding)) {
      return invalidEHistory("stored action canonical binding differs from the frozen v3 Quality binding");
    }
    return reconcileCurrentOutputE(db, {
      key: parsed,
      actionId: action.id,
      source: preparation.qualityBinding.source,
      binding: preparation.qualityBinding.canonicalBinding,
      request: requestFromQualityPreparation(preparation),
    });
  }
  {
    const reviewItemId = await findActionReviewItem(db, parsed.companyId, action.occurrenceIds);
    const qualified = await prepareQualification(db, {
      companyId: parsed.companyId, source, bindingStepRunId: binding.stepRunId, action, reviewItemId,
    });
    if (!(qualified instanceof CurrentOutputUnsupported) && qualified.status === "correction") {
      return issueQualityCorrection(db, qualified.preparation);
    }
  }
  const request = {
    companyId: parsed.companyId,
    missionId: source.mission.id,
    workflowRunId: source.workflow.runId,
    producerStepRunId: source.workflow.stepRunId,
    qaStepRunIds: [binding.stepRunId],
    qualityActionId: action.id,
  };
  return reconcileCurrentOutputE(db, { key: parsed, actionId: action.id, source, binding, request });
}

async function readCurrentOutputEHistory(db: CurrentOutputEReaderDb, companyId: string, action: ActionRow, source: SourceAttempt): Promise<CurrentOutputEHistory> {
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_prepared"),
    sql`${workflowTransitionEvents.payload}->'qualityBinding'->>'actionId' = ${action.id}`,
  ));
  if (rows.length === 0) return { kind: "none" };
  if (rows.length !== 1) return { kind: "invalid", detail: "multiple v3 Quality preparations exist for this action" };

  try {
    const row = rows[0]!;
    const preparation = parseQaRemediationPreparation(row.payload);
    if (preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
      return { kind: "invalid", detail: "stored Quality preparation is not strict v3" };
    }
    const quality = preparation.qualityBinding;
    const canonical = quality.canonicalBinding;
    const canonicalVerdicts = preparation.verdicts.filter((verdict) =>
      verdict.qa.stepRunId === canonical.stepRunId && verdict.qa.issueId === canonical.issueId
      && verdict.heartbeatRunId === quality.verifierRunId);
    const exact = row.id === preparation.preparationId
      && row.eventType === "qa_remediation_prepared"
      && row.layer === "workflow_validation"
      && row.companyId === preparation.companyId
      && row.missionId === preparation.missionId
      && row.workflowRunId === preparation.workflowRunId
      && row.workflowStepRunId === preparation.producer.stepRunId
      && row.issueId === preparation.producer.issueId
      && row.executionGeneration === preparation.producer.executionGeneration
      && row.idempotencyKey === qaRemediationPreparationKey(preparation)
      && preparation.companyId === companyId
      && quality.actionId === action.id
      && quality.groupId === action.groupId
      && quality.policyVersionId === action.policyVersionId
      && quality.intentKey === action.intentKey
      && quality.targetHash === action.targetHash
      && quality.effectHash === action.effectHash
      && quality.retryEnvelopeHash === hashContract(action.retryEnvelope)
      && hashContract(quality.source) === hashContract(source)
      && canonical.companyId === companyId
      && canonical.actionId === action.id
      && canonical.missionId === preparation.missionId
      && canonical.workflowRunId === preparation.workflowRunId
      && canonicalVerdicts.length === 1;
    if (!exact) return { kind: "invalid", detail: "stored v3 Quality source, action, or canonical QA binding does not match" };
    return { kind: "exact", preparation };
  } catch {
    return { kind: "invalid", detail: "stored v3 Quality preparation failed strict schema validation" };
  }
}

function requestFromQualityPreparation(preparation: Extract<ReturnType<typeof parseQaRemediationPreparation>, { schemaVersion: typeof QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 }>) {
  return {
    companyId: preparation.companyId,
    missionId: preparation.missionId,
    workflowRunId: preparation.workflowRunId,
    producerStepRunId: preparation.producer.stepRunId,
    qaStepRunIds: [preparation.qualityBinding.canonicalBinding.stepRunId],
    qualityActionId: preparation.qualityBinding.actionId,
  };
}

function invalidEHistory(detail: string): CurrentOutputCorrectionStatus {
  return { status: "unsupported_target", evidenceRefId: null,
    remediation: { outcome: "unknown", reason: "invalid_history", detail } };
}

async function reconcileCurrentOutputE(db: Db, input: {
  key: QualityKey;
  actionId: string;
  source: SourceAttempt;
  binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>;
  request: Parameters<typeof reconcileQaRemediationReservation>[1];
}): Promise<CurrentOutputCorrectionStatus> {
  const notifications = createReplacementRootNotifications();
  let reconciled: Awaited<ReturnType<typeof reconcileQaRemediationReservation>>;
  try {
    reconciled = await withReplacementRootNotificationDb(db, notifications, () =>
      reconcileQaRemediationReservation(db, input.request, createQaFileOwnerRuntime(loadConfig())));
  } catch (error) {
    return {
      status: "unsupported_target",
      evidenceRefId: null,
      remediation: { outcome: "unknown", reason: "reconcile_failed", detail: error instanceof Error ? error.message : String(error) },
    };
  }

  if (reconciled.outcome === "not_applicable") {
    return { status: "unsupported_target", evidenceRefId: null,
      remediation: { outcome: "not_applicable", detail: reconciled.detail } };
  }
  if (reconciled.outcome !== "completed") return mapHeldRemediation(reconciled);

  const completion = reconciled.completion;
  const wakeIds = completion.wakes.map((wake) => wake.wakeupRequestId);
  let drainError: unknown;
  try { await drainReplacementRootNotifications(db, notifications); }
  catch (error) { drainError = error; }
  if (completion.schemaVersion !== QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3
    || completion.completionId !== reconciled.completionEventId) {
    return { status: "unsupported_target", evidenceRefId: null,
      remediation: { outcome: "unknown", reason: "completion_binding_invalid", detail: "E completion lacks the exact strict v3 Quality/use identity",
        completionEventId: reconciled.completionEventId, wakeupRequestIds: wakeIds } };
  }
  const canonicalWakes = completion.wakes.filter((wake) =>
    wake.stepRunId === input.binding.stepRunId && wake.issueId === input.binding.issueId);
  if (canonicalWakes.length !== 1 || completion.wakes.length !== 1) {
    return { status: "unsupported_target", evidenceRefId: null,
      remediation: { outcome: "unknown", reason: "canonical_wake_ambiguous", detail: "E completion does not identify one exact wake for the current canonical QA binding",
        completionEventId: reconciled.completionEventId, qualityUseEvidenceRefId: completion.qualityUseEvidenceRefId,
        wakeupRequestIds: wakeIds } };
  }
  const completed: Extract<CurrentOutputRemediationOutcome, { outcome: "completed" }> = {
    outcome: "completed", schemaVersion: QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3,
    preparationId: completion.preparationId, completionEventId: reconciled.completionEventId,
    qualityUseEvidenceRefId: completion.qualityUseEvidenceRefId,
    wakeupRequestIds: wakeIds, canonicalWakeupRequestId: canonicalWakes[0]!.wakeupRequestId,
    canonicalStepRunId: input.binding.stepRunId, canonicalIssueId: input.binding.issueId,
  };
  if (drainError) {
    return { status: "verification_pending", evidenceRefId: completion.qualityUseEvidenceRefId,
      remediation: { outcome: "unknown", reason: "root_drain_failed",
        detail: drainError instanceof Error ? drainError.message : String(drainError),
        completionEventId: completed.completionEventId, qualityUseEvidenceRefId: completed.qualityUseEvidenceRefId,
        wakeupRequestIds: completed.wakeupRequestIds } };
  }
  return evaluateVerification(db, { key: input.key, actionId: input.actionId, binding: input.binding,
    source: input.source, remediation: completed });
}

class CurrentOutputUnsupported extends Error {}

/** Keep the immutable C03 issuer distinct from E's non-C03 publication path. */
async function prepareQualification(db: Db, input: {
  companyId: string;
  source: SourceAttempt;
  bindingStepRunId: string;
  action: ActionRow;
  reviewItemId: string | null;
}) {
  const source = input.source;
  const sourceWorkflow = source.workflow;
  if (sourceWorkflow.kind !== "workflow_step") return new CurrentOutputUnsupported();
  const runId = sourceWorkflow.runId;
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.id, runId)));
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, input.companyId), eq(workflowDefinitions.id, run?.workflowId ?? "")));
  if (!run || !definition) return new CurrentOutputUnsupported();
  const steps = normalizeWorkflowStepsForExecution(definition.stepsJson) as unknown as EdgeBearingStep[];
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  const producerStepRunId = sourceWorkflow.stepRunId;
  const producerRun = stepRuns.find((row) => row.id === producerStepRunId);
  const producerStep = steps.find((step) => step.id === producerRun?.stepId);
  if (!producerRun || !producerStep) return new CurrentOutputUnsupported();
  const verdictRows = await db.select({ stepRunId: workflowTransitionEvents.workflowStepRunId, issueId: workflowTransitionEvents.issueId })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.verdict, "request_changes"),
    ));
  const rejectedQas = [];
  const findingsByQaStepId = new Map<string, Awaited<ReturnType<typeof loadWorkflowApiFindings>>>();
  for (const row of stepRuns) {
    if (row.id === producerRun.id || !row.issueId) continue;
    if (!verdictRows.some((v) => v.stepRunId === row.id && v.issueId === row.issueId)) continue;
    rejectedQas.push({ edge: { stepId: row.stepId }, qaRun: row });
    findingsByQaStepId.set(row.stepId, await loadWorkflowApiFindings({
      db, companyId: input.companyId, issueId: row.issueId, workflowRunId: runId, workflowStepRunId: row.id,
    }));
  }
  const found = await discoverQaCorrection({ db, run, steps, producerStep, producerRun, rejectedQas, findingsByQaStepId });
  if (found && input.reviewItemId) {
    const p = found.p, a = input.action;
    const [existing] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, p.correctionId));
    if (existing) return new CurrentOutputUnsupported();
    const verifierId = p.authority.verdicts.find((v) => v.qa.stepRunId === input.bindingStepRunId)?.heartbeatRunId;
    const [verifier] = verifierId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, verifierId)) : [];
    if (!verifier || verifier.executionEpoch === null) return new CurrentOutputUnsupported();
    return { status: "correction" as const, preparation: { ...p, authority: {
      kind: "quality_current_output" as const, verdicts: p.authority.verdicts, actionId: a.id, groupId: a.groupId,
      policyVersionId: a.policyVersionId, intentKey: a.intentKey, targetHash: a.targetHash, effectHash: a.effectHash,
      retryEnvelopeHash: hashContract(a.retryEnvelope), source, reviewItemId: input.reviewItemId,
      verifierRunId: verifier.id, verifierEpoch: verifier.executionEpoch,
    } } };
  }
  const prepared = await collectQualifiableQaRemediations({
    db, run: { id: runId, companyId: input.companyId, status: run.status ?? "running", missionId: run.missionId ?? null },
    steps, producerStep, producerRun, rejectedQas, findingsByQaStepId,
    refireQaStep: async () => false,
  });
  if (prepared.status !== "qualified") return prepared.status === "waiting"
    ? { status: "waiting" as const } : new CurrentOutputUnsupported();
  const [verifierHeartbeat] = await db.select({ id: heartbeatRuns.id, epoch: heartbeatRuns.executionEpoch })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, prepared.qualified[0]!.heartbeatRunId ?? "")));
  if (!verifierHeartbeat || verifierHeartbeat.epoch === null) return new CurrentOutputUnsupported();
  return {
    status: "qualified" as const, run: { id: runId, companyId: input.companyId, status: run.status ?? "running", missionId: run.missionId ?? null },
    producerStep, producerRun, qualified: prepared.qualified, fileBuffers: prepared.fileBuffers,
    verifierHeartbeatId: verifierHeartbeat.id, verifierEpoch: verifierHeartbeat.epoch,
  };
}

async function findActionReviewItem(db: Db, companyId: string, occurrenceIds: string[]): Promise<string | null> {
  const ids = [...occurrenceIds].sort();
  if (!ids.length) return null;
  const [row] = await db.select({ reviewItemId: qualityOccurrences.reviewItemId }).from(qualityOccurrences)
    .where(and(eq(qualityOccurrences.companyId, companyId), eq(qualityOccurrences.id, ids[0]!)));
  return row?.reviewItemId ?? null;
}

/** Issuance is history only. Pending B uses the current reader; consumed B replays its stored effect. */
async function issueQualityCorrection(db: Db, p: QaCorrectionPreparation): Promise<CurrentOutputCorrectionStatus> {
  requireQaCorrection(!is(db, PgTransaction), "record");
  const prepared = await beginQaCorrection(db, p);
  let proof: IssuedQaCorrection, appliedEventId: string;
  if (prepared.status === "already_applied") ({ proof, appliedEventId } = prepared);
  else {
    if (prepared.status !== "prepared" && prepared.status !== "existing") return UNSUPPORTED;
    const measured = await measureQaCorrectionSources(db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    const committed = await commitQaCorrection(db, await storeQaCorrection(db, measured));
    if (committed.status === "stopped") return UNSUPPORTED;
    ({ proof, appliedEventId } = committed);
  }
  for (const f of proof.followups) {
    const ref = { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId, requestId: f.requestId };
    if (!await readQaCorrectionFollowupConsumption(db, ref, readIssuedQaCorrection)) {
      await readQaCorrectionFollowupDb(db, ref, readIssuedQaCorrection);
    }
  }
  return { status: "verification_pending", evidenceRefId: proof.applied.qualityUseEvidenceRefId };
}

function mapHeldRemediation(result: Exclude<Awaited<ReturnType<typeof reconcileQaRemediationReservation>>, { outcome: "completed" | "not_applicable" }>): CurrentOutputCorrectionStatus {
  const files = "files" in result ? result.files.map((file) => ({ file: file.file, status: file.status, detail: file.detail })) : undefined;
  const appliedPrefix = files?.some((file) => file.status === "applied" || file.status === "already_applied") ?? false;
  const unknown = (result.outcome === "publication_io_error" && !appliedPrefix)
    || (result.outcome === "held" && (result.reason === "transaction_outcome_unknown" || result.reason === "owner_lost"));
  const outcome: "held" | "partial" | "unknown" = unknown ? "unknown"
    : appliedPrefix ? "partial" : "held";
  return { status: "unsupported_target", evidenceRefId: null,
    remediation: { outcome, reason: result.outcome === "held" || result.outcome === "publication_held" ? result.reason : result.outcome,
      detail: result.detail, ...(files ? { files } : {}) } };
}

/** Recheck only the exact E completion, its admitted wake, and an independent official PASS observation. */
async function evaluateVerification(db: Db, input: {
  key: QualityKey;
  actionId: string;
  binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>;
  source: SourceAttempt;
  remediation: Extract<CurrentOutputRemediationOutcome, { outcome: "completed" }>;
}): Promise<CurrentOutputCorrectionStatus> {
  const { key, binding, remediation } = input;
  const pending: CurrentOutputCorrectionStatus = {
    status: "verification_pending", evidenceRefId: remediation.qualityUseEvidenceRefId, remediation,
  };
  if (input.source.mission.kind !== "mission" || input.source.workflow.kind !== "workflow_step") return pending;
  const admission = await readCurrentOutputEAdmission(db, key);
  if (admission.kind !== "admitted" || admission.wakeupRequestId !== remediation.canonicalWakeupRequestId
    || admission.preparation.preparationId !== remediation.preparationId
    || admission.completionEvent.id !== remediation.completionEventId
    || admission.completion.qualityUseEvidenceRefId !== remediation.qualityUseEvidenceRefId
    || admission.actual.status !== "succeeded"
    || hashContract(admission.preparation.qualityBinding.source) !== hashContract(input.source)
    || hashContract(admission.preparation.qualityBinding.canonicalBinding) !== hashContract(binding)
    || admission.preparation.qualityBinding.canonicalBinding.stepRunId !== binding.stepRunId
    || admission.preparation.qualityBinding.canonicalBinding.issueId !== binding.issueId) return pending;
  const { completionEvent, actual, preparation } = admission;
  const verdict = preparation.verdicts.find((candidate) => candidate.qa.stepRunId === binding.stepRunId
    && candidate.qa.issueId === binding.issueId);
  if (!verdict || actual.executionEpoch === null) return pending;
  const passRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, key.companyId),
    eq(workflowTransitionEvents.missionId, preparation.missionId),
    eq(workflowTransitionEvents.workflowRunId, preparation.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, verdict.qa.stepRunId),
    eq(workflowTransitionEvents.issueId, verdict.qa.issueId),
    eq(workflowTransitionEvents.executionGeneration, verdict.qa.executionGeneration),
    eq(workflowTransitionEvents.reasonCode, "workflow_api"),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.verdict, "pass"),
    eq(workflowTransitionEvents.heartbeatRunId, actual.id),
  )).limit(2);
  const pass = passRows.length === 1 ? passRows[0] : undefined;
  const passPayload = pass?.payload && typeof pass.payload === "object" && !Array.isArray(pass.payload)
    ? pass.payload as Record<string, unknown> : null;
  if (!pass || pass.createdAt <= completionEvent.createdAt
    || passPayload?.kind !== "workflow_validation_verdict"
    || passPayload.workflowRunId !== preparation.workflowRunId
    || passPayload.stepRunId !== verdict.qa.stepRunId
    || passPayload.issueId !== verdict.qa.issueId || passPayload.verdict !== "pass") return pending;

  const observationReceipts = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract,
    status: qualityEvidenceRefs.status, sourceRunId: qualityEvidenceRefs.sourceRunId })
    .from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, key.companyId), eq(qualityEvidenceRefs.qualityActionId, input.actionId),
      sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'observation'`,
    )).orderBy(desc(qualityEvidenceRefs.id));
  const [producerHeartbeat] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, key.companyId), eq(heartbeatRuns.id, input.source.heartbeatRunId)));
  for (const receipt of observationReceipts) {
    const contract = evidenceContractSchema.safeParse(receipt.contract);
    if (!contract.success || contract.data.kind !== "observation" || receipt.status !== "verified"
      || receipt.sourceRunId !== input.source.heartbeatRunId) continue;
    const scope = outputCorrectionScopeSchema.safeParse(contract.data.scope);
    if (!scope.success || scope.data.companyId !== key.companyId || scope.data.actionId !== input.actionId
      || scope.data.verifierRunId !== actual.id || scope.data.verifierEpoch !== actual.executionEpoch
      || hashContract(scope.data.source) !== hashContract(input.source)) continue;
    if (!producerHeartbeat || actual.agentId === producerHeartbeat.agentId) continue;
    const rows = await db.update(qualityActions).set({ state: "corrected", updatedAt: new Date() })
      .where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, input.actionId), sql`${qualityActions.state} <> 'corrected'`))
      .returning({ id: qualityActions.id });
    if (rows.length > 0) {
      await insertActivityRecord(db, {
        companyId: key.companyId, actorType: "system", actorId: "quality",
        action: "quality.correction_verified", entityType: "quality_action", entityId: input.actionId,
        details: { evidenceRefId: receipt.id, verifierRunId: actual.id },
      });
    }
    return { status: "verification_pending", evidenceRefId: receipt.id, remediation };
  }
  return pending;
}

async function currentOutputHasC5Scope(db: Db, companyId: string, runId: string): Promise<boolean> {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, runId)));
  if (!run) return true;
  const [authority] = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, companyId), or(eq(workflowRecoveryAuthorities.workflowRunId, runId), eq(workflowRecoveryAuthorities.replacementRunId, runId)))).limit(1);
  const [history] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    inArray(workflowTransitionEvents.eventType, ["qa_remediation_prepared", "qa_remediation_completed", "qa_correction_prepared"])) ).limit(1);
  const [actual] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(workflowStepRuns, eq(workflowStepRuns.id, heartbeatRuns.workflowStepRunId))
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(workflowStepRuns.workflowRunId, runId), isNotNull(heartbeatRuns.executorOwnerId), isNotNull(heartbeatRuns.executionToken))).limit(1);
  const [held] = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId), inArray(workflowStepRuns.status, ["held", "blocked"])) ).limit(1);
  if (authority || history) await hasPendingQaRemediationForRun(db, run);
  return Boolean(authority || history || actual || held);
}

async function applyLegacyCurrentOutput(db: Db, input: {
  key: QualityKey; action: ActionRow; source: SourceAttempt;
  binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>;
  envelope: ReturnType<typeof retryEnvelopeSchema.parse>;
}): Promise<CurrentOutputCorrectionStatus> {
  const { key: parsed, action, source, binding } = input, envelope = { data: input.envelope };
  const reviewItemId = await findActionReviewItem(db, parsed.companyId, action.occurrenceIds);
  const [usedRow] = await db.select({ n: sql<number>`count(*)::int` }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, parsed.companyId), eq(qualityEvidenceRefs.qualityActionId, action.id), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
  const appliedCount = usedRow?.n ?? 0;
  if (!reviewItemId && appliedCount === 0) return UNSUPPORTED;
  const prepared = await prepareQualification(db, { companyId: parsed.companyId, source, bindingStepRunId: binding.stepRunId, action, reviewItemId });
  if (prepared instanceof CurrentOutputUnsupported && appliedCount === 0) return UNSUPPORTED;
  if (prepared instanceof CurrentOutputUnsupported || prepared.status === "waiting") {
    return await evaluateLegacyVerification(db, { key: parsed, actionId: action.id, binding, source });
  }
  if (prepared.status === "correction") return issueQualityCorrection(db, prepared.preparation);
  if (appliedCount >= envelope.data.maxExecutorAttempts) return UNSUPPORTED;
  if (!reviewItemId) return UNSUPPORTED;
  const fileHashes = [...prepared.fileBuffers.entries()].map(([file, entry]) => ({
    file, before: entry.beforeHash, after: createHash("sha256").update(entry.content).digest("hex"),
  }));
  const receiptBody = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: "quality_current_output_correction", qualityActionId: action.id,
    sourceAttemptHash: hashContract(source), fileHashes,
  }));
  let uploaded;
  try {
    uploaded = await uploadEvidence(getStorageService(), { companyId: parsed.companyId, body: receiptBody, contentType: "application/json", originalFilename: "current-output-correction.json" });
  } catch {
    return UNSUPPORTED;
  }
  const { writeError } = await writeLegacyQaRemediationPatches({
    db, run: prepared.run, producerStep: prepared.producerStep, producerRun: prepared.producerRun,
    qualified: prepared.qualified, fileBuffers: prepared.fileBuffers,
    extraEventPayload: () => ({
      qualityActionId: action.id,
      qualityFileHashes: fileHashes,
      qualitySourceAttemptHash: hashContract(source),
    }),
  });
  if (writeError) return UNSUPPORTED;
  const linked = await db.transaction(async (tx) => linkEvidence(tx, {
    companyId: parsed.companyId, reviewItemId, source,
    scope: { kind: "output_correction", companyId: parsed.companyId, actionId: action.id, source, verifierRunId: prepared.verifierHeartbeatId, verifierEpoch: prepared.verifierEpoch },
    kind: "use", uploaded, expiresAt: envelope.data.deadlineAt, issuedBy: "quality:current-output",
  }));
  return { status: "verification_pending", evidenceRefId: linked.evidenceRefId };
}

async function writeLegacyQaRemediationPatches(input: Pick<TryQaRemediationInput, "db" | "run" | "producerStep" | "producerRun"> & {
  qualified: readonly QualifiedQa[]; fileBuffers: ReadonlyMap<string, PreparedFile>;
  extraEventPayload?: (qa: QualifiedQa) => Record<string, unknown>;
}): Promise<{ writeError: string | null }> {
  const { db, run } = input;
  let writeError: string | null = null;
  for (const [file, entry] of input.fileBuffers) {
    try {
      await writeFile(file, entry.content, "utf8");
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const nowIso = new Date().toISOString();
  for (const qa of input.qualified) {
    await db.insert(workflowTransitionEvents).values({
      companyId: run.companyId,
      missionId: run.missionId ?? null,
      workflowRunId: run.id,
      workflowStepRunId: qa.qaRun.id,
      issueId: qa.qaRun.issueId ?? null,
      heartbeatRunId: qa.heartbeatRunId,
      eventType: QA_REMEDIATION_EVENT_TYPE,
      layer: "workflow_validation",
      decision: writeError ? "mechanical_remediation_write_failed" : "mechanical_remediation_applied",
      verdict: "request_changes",
      reason: "workflow_api",
      reasonCode: "qa_remediation",
      idempotencyKey: remediationIdempotencyKey(run.companyId, qa.qaRun.id, qa.sourceVerdictEventId),
      payload: {
        kind: "qa_remediation_applied",
        outcome: writeError ? "write_failed" : "applied",
        producerStepId: input.producerStep.id,
        producerStepRunId: input.producerRun.id,
        producerIteration: input.producerRun.iterationIndex ?? 0,
        qaStepId: qa.qaRun.stepId,
        sourceVerdictEventId: qa.sourceVerdictEventId,
        appliedAt: nowIso,
        items: qa.remediations.items,
        signatures: qa.remediations.items.map((item) => computeDefectSignature(item.find, item.replace)),
        ...(input.extraEventPayload ? input.extraEventPayload(qa) : {}),
        ...(writeError ? { writeError } : {}),
      },
    }).onConflictDoNothing();
  }
  return { writeError };
}

async function evaluateLegacyVerification(db: Db, input: {
  key: QualityKey; actionId: string; binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>; source: { heartbeatRunId: string };
}): Promise<CurrentOutputCorrectionStatus> {
  const { key, binding } = input;
  const [appliedEvent] = await db.select({ createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, key.companyId), eq(workflowTransitionEvents.workflowStepRunId, binding.stepRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_applied")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  const [useReceipt] = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, key.companyId), eq(qualityEvidenceRefs.qualityActionId, input.actionId), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`))
    .orderBy(desc(qualityEvidenceRefs.id)).limit(1);
  const pending: CurrentOutputCorrectionStatus = { status: "verification_pending", evidenceRefId: useReceipt?.id ?? null };
  if (!appliedEvent) return pending;
  const observationReceipts = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, key.companyId), eq(qualityEvidenceRefs.qualityActionId, input.actionId), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'observation'`))
    .orderBy(desc(qualityEvidenceRefs.id));
  const [producerHeartbeat] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, key.companyId), eq(heartbeatRuns.id, input.source.heartbeatRunId)));
  for (const receipt of observationReceipts) {
    const contract = evidenceContractSchema.safeParse(receipt.contract);
    if (!contract.success || contract.data.kind !== "observation") continue;
    const scope = outputCorrectionScopeSchema.safeParse(contract.data.scope);
    if (!scope.success) continue;
    const [pass] = await db.select({ id: workflowTransitionEvents.id, heartbeatRunId: workflowTransitionEvents.heartbeatRunId, createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.companyId, key.companyId), eq(workflowTransitionEvents.workflowStepRunId, binding.stepRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.verdict, "pass"),
        eq(workflowTransitionEvents.heartbeatRunId, scope.data.verifierRunId),
      )).limit(1);
    if (!pass || pass.createdAt < appliedEvent.createdAt) continue;
    const [verifier] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, key.companyId), eq(heartbeatRuns.id, scope.data.verifierRunId)));
    if (!verifier || !producerHeartbeat || verifier.agentId === producerHeartbeat.agentId) continue;
    const rows = await db.update(qualityActions).set({ state: "corrected", updatedAt: new Date() })
      .where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, input.actionId), sql`${qualityActions.state} <> 'corrected'`))
      .returning({ id: qualityActions.id });
    if (rows.length > 0) {
      await insertActivityRecord(db, {
        companyId: key.companyId, actorType: "system", actorId: "quality",
        action: "quality.correction_verified", entityType: "quality_action", entityId: input.actionId,
        details: { evidenceRefId: receipt.id, verifierRunId: scope.data.verifierRunId },
      });
    }
    return { status: "verification_pending", evidenceRefId: receipt.id };
  }
  return pending;
}
