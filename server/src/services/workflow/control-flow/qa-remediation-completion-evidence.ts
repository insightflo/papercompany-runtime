// Strict v2/v3 completion receipts and their persisted evidence checks.
import { isDeepStrictEqual as same } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests, assets, issueAttachments, qualityEvidenceRefs, qualityReviewItems, workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { sha256HexSchema, type EvidenceScope } from "@paperclipai/shared";
import { z } from "zod";
import { HttpError } from "../../../errors.js";
import { hashQaCorrectionPayload, qaCorrectionAttemptSchema, qaCorrectionVerdictAuthoritySchema } from "./qa-correction-contract.js";
import { QA_REMEDIATION_PREPARATION_SCHEMA_VERSION, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
  type QaRemediationEventRow, type QaRemediationPreparation } from "./qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash, type QaRemediationQualityBinding } from "./qa-remediation-quality-binding.js";
import type { QaRemediationFilePublication } from "./qa-remediation-publication.js";
import { loadEvidenceReceipt } from "../../quality/evidence-verifier.js";
import { readWorkflowAttemptProof } from "../../heartbeat-finalization/workflow-attempt-proof.js";

export const QA_REMEDIATION_COMPLETION_SCHEMA_VERSION = "workflow.qa-remediation.complete.v2";
export const QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3 = "workflow.qa-remediation.complete.v3";

const uuid = z.string().uuid();
const count = z.number().int().safe().nonnegative();
const timestamp = z.string().datetime({ offset: true });

/** A receipt identifies the accepted wake row; status is not execution authority. */
export const qaRemediationCompletionWakeSchema = z.object({
  kind: z.literal("v2_refire"),
  wakeupRequestId: uuid, idempotencyKey: z.string().min(1), agentId: uuid, issueId: uuid,
  stepRunId: uuid, stepId: z.string().min(1), executionGeneration: count,
  sourceVerdictEventId: uuid, statusAtCommit: z.string().min(1),
}).strict();

const completionFields = z.object({
  completionId: uuid, preparationId: uuid,
  companyId: uuid, missionId: uuid, workflowRunId: uuid, dispatchAuthorityVersion: count,
  producer: qaCorrectionAttemptSchema,
  verdicts: z.array(qaCorrectionVerdictAuthoritySchema).min(1),
  files: z.array(z.object({
    file: z.string().min(1),
    status: z.enum(["applied", "already_applied", "held", "mismatch_held", "io_error", "not_attempted"]),
    detail: z.string(),
  }).strict()).min(1),
  wakes: z.array(qaRemediationCompletionWakeSchema).min(1),
  completedAt: timestamp,
});

function hasExactWakeCoverage(completion: z.infer<typeof completionFields>): boolean {
  return new Set(completion.wakes.map((wake) => wake.stepRunId)).size === completion.wakes.length
    && new Set(completion.verdicts.map((verdict) => verdict.qa.stepRunId)).size === completion.wakes.length
    && completion.wakes.every((wake) => completion.verdicts.some((verdict) =>
      verdict.qa.stepRunId === wake.stepRunId && verdict.eventId === wake.sourceVerdictEventId));
}

export const qaRemediationWorkflowCompletionSchema = completionFields.extend({
  schemaVersion: z.literal(QA_REMEDIATION_COMPLETION_SCHEMA_VERSION),
}).strict().refine(hasExactWakeCoverage, "qa_remediation_completion_wake_coverage");

export const qaRemediationQualityCompletionSchema = completionFields.extend({
  schemaVersion: z.literal(QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3),
  qualityUseEvidenceRefId: uuid,
  qualityBindingHash: sha256HexSchema,
}).strict().refine(hasExactWakeCoverage, "qa_remediation_completion_wake_coverage");

export const qaRemediationCompletionSchema = z.union([
  qaRemediationWorkflowCompletionSchema, qaRemediationQualityCompletionSchema,
]);
export type QaRemediationCompletionWake = z.infer<typeof qaRemediationCompletionWakeSchema>;
export type QaRemediationCompletion = z.infer<typeof qaRemediationCompletionSchema>;

export function parseQaRemediationCompletion(payload: unknown): QaRemediationCompletion {
  return qaRemediationCompletionSchema.parse(payload);
}

export const qaRemediationRefireV2WakeKey = (p: QaRemediationPreparation, qaStepRunId: string, sourceVerdictEventId: string): string =>
  `qa-remediation-refire-v2:${p.companyId}:${p.workflowRunId}:${p.producer.stepRunId}:${qaStepRunId}:${sourceVerdictEventId}`;

export const qaRemediationCompletionKey = (p: QaRemediationPreparation): string =>
  `qa-remediation-completed:${p.companyId}:${p.workflowRunId}:${p.producer.stepRunId}:${p.verdicts.map((verdict) => verdict.eventId).sort().join("+")}`;

export type QaRemediationQualityPreparation = Extract<QaRemediationPreparation,
  { schemaVersion: typeof QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 }>;

export function qaRemediationQualityUseScope(p: QaRemediationQualityPreparation): EvidenceScope {
  const binding = p.qualityBinding;
  return { kind: "output_correction", companyId: p.companyId, actionId: binding.actionId,
    source: binding.source, verifierRunId: binding.verifierRunId, verifierEpoch: binding.verifierEpoch };
}

export function qaRemediationSuccessfulPublicationFiles(
  p: QaRemediationPreparation,
  files: readonly Pick<QaRemediationFilePublication, "file" | "status">[],
): boolean {
  const reserved = new Set(p.files.map((file) => file.path));
  const published = new Set(files.map((file) => file.file));
  return reserved.size === p.files.length && published.size === files.length && published.size === reserved.size
    && files.every((file) => reserved.has(file.file) && (file.status === "applied" || file.status === "already_applied"));
}

type WakeRow = typeof agentWakeupRequests.$inferSelect;
type SourceVerdict = QaRemediationPreparation["verdicts"][number];

function bindV2RefireWakeRow(row: WakeRow, verdict: SourceVerdict, p: QaRemediationPreparation):
{ ok: true } | { ok: false; reason: string; detail: string } {
  const pointer = ((row.payload ?? {}) as Record<string, unknown>).qaRemediationCompletion as Record<string, unknown> | undefined;
  if (row.companyId !== p.companyId || row.missionId !== p.missionId || row.workflowRunId !== p.workflowRunId
    || row.issueId !== verdict.qa.issueId || row.workflowStepRunId !== verdict.qa.stepRunId
    || row.workflowExecutionGeneration !== verdict.qa.executionGeneration || row.requestKind !== "workflow_resume"
    || row.idempotencyKey !== qaRemediationRefireV2WakeKey(p, verdict.qa.stepRunId, verdict.eventId)
    || pointer?.preparationEventId !== p.preparationId || pointer?.sourceVerdictEventId !== verdict.eventId) {
    return { ok: false, reason: "v2_wake_binding_mismatch", detail: "wake row columns/key/pointer do not bind this preparation and its exact source verdict" };
  }
  let proof: ReturnType<typeof readWorkflowAttemptProof>;
  try { proof = readWorkflowAttemptProof(row); }
  catch { return { ok: false, reason: "wake_attempt_proof_invalid", detail: "stored producer attempt proof is missing, malformed, or not bound to this wake row" }; }
  if (proof.companyId !== p.companyId || proof.missionId !== p.missionId || proof.workflowRunId !== p.workflowRunId
    || proof.issueId !== verdict.qa.issueId || proof.stepRunId !== verdict.qa.stepRunId
    || proof.executionGeneration !== verdict.qa.executionGeneration || proof.retryCount !== verdict.qa.retryCount
    || proof.iterationIndex !== verdict.qa.iterationIndex) {
    return { ok: false, reason: "wake_attempt_proof_invalid", detail: "stored attempt proof does not bind the exact source-verdict qa attempt (retry/iteration/generation)" };
  }
  return { ok: true };
}

export function validatePendingQaRemediationRefireWake(row: WakeRow, verdict: SourceVerdict,
  p: QaRemediationPreparation, expectedAgentId: string): { ok: true } | { ok: false; reason: string; detail: string } {
  if (!["queued", "deferred_issue_execution"].includes(row.status)) {
    return { ok: false, reason: "v2_wake_binding_mismatch", detail: "existing same-key wake is not pending" };
  }
  const bound = bindV2RefireWakeRow(row, verdict, p);
  if (!bound.ok) return bound;
  if (row.agentId !== expectedAgentId) {
    return { ok: false, reason: "v2_wake_binding_mismatch", detail: "existing wake is not bound to the current intended agent" };
  }
  return { ok: true };
}

function bindWakeReceipt(wake: QaRemediationCompletionWake, row: WakeRow, verdict: SourceVerdict):
{ ok: true } | { ok: false; reason: string; detail: string } {
  if (wake.wakeupRequestId !== row.id || wake.idempotencyKey !== row.idempotencyKey || wake.agentId !== row.agentId
    || wake.issueId !== verdict.qa.issueId || wake.stepRunId !== verdict.qa.stepRunId
    || wake.stepId !== verdict.qa.stepId || wake.executionGeneration !== verdict.qa.executionGeneration
    || wake.sourceVerdictEventId !== verdict.eventId) {
    return { ok: false, reason: "wake_evidence_missing", detail: "recorded wake receipt does not match the live row and the source verdict" };
  }
  return { ok: true };
}

async function validateQualityUseEvidence(db: Db, p: QaRemediationQualityPreparation,
  completion: Extract<QaRemediationCompletion, { schemaVersion: typeof QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3 }>):
Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  const binding: QaRemediationQualityBinding = p.qualityBinding;
  if (completion.qualityBindingHash !== qaRemediationQualityBindingHash(binding)) {
    return { ok: false, reason: "quality_binding_mismatch", detail: "completion does not bind the frozen Quality preparation" };
  }

  let loaded: Awaited<ReturnType<typeof loadEvidenceReceipt>>;
  try { loaded = await loadEvidenceReceipt(db, p.companyId, completion.qualityUseEvidenceRefId, "use"); }
  catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "quality_use_receipt_invalid", detail: error.message };
    throw error;
  }
  const { receipt, contract } = loaded;
  const attachmentId = contract.ref.attachmentId;
  const rows = await db.select({ receipt: qualityEvidenceRefs, review: qualityReviewItems, attachment: issueAttachments, asset: assets })
    .from(qualityEvidenceRefs)
    .innerJoin(qualityReviewItems, and(eq(qualityReviewItems.companyId, p.companyId), eq(qualityReviewItems.id, qualityEvidenceRefs.reviewItemId)))
    .innerJoin(issueAttachments, and(eq(issueAttachments.companyId, p.companyId), eq(issueAttachments.id, attachmentId)))
    .innerJoin(assets, and(eq(assets.companyId, p.companyId), eq(assets.id, issueAttachments.assetId)))
    .where(and(eq(qualityEvidenceRefs.companyId, p.companyId),
      sql`${qualityEvidenceRefs.qualityContract}->'ref'->>'attachmentId' = ${attachmentId}`)).limit(2);
  if (rows.length !== 1 || rows[0]!.receipt.id !== receipt.id || receipt.status !== "verified"
    || receipt.surface !== "attachment" || receipt.reviewItemId !== binding.reviewItemId
    || receipt.qualityActionId !== binding.actionId || receipt.sourceRunId !== binding.source.heartbeatRunId) {
    return { ok: false, reason: "quality_use_receipt_binding_mismatch", detail: "exact use receipt or its company/review/action/source joins do not match" };
  }
  const { attachment, asset } = rows[0]!;
  const expectedScope = qaRemediationQualityUseScope(p);
  const uploaded = binding.uploadedEvidence;
  const expiryMillis = Date.parse(binding.expiresAt);
  if (contract.kind !== "use" || contract.issuedBy !== "quality:current-output"
    || !same(contract.source, binding.source) || !same(contract.scope, expectedScope) || contract.originalRef !== null
    || contract.expiresAt !== binding.expiresAt || !Number.isFinite(expiryMillis)
    || receipt.freshnessExpiresAt?.getTime() !== expiryMillis
    || receipt.collectedByActorType !== "system" || receipt.collectedByActorId !== "quality:current-output"
    || receipt.qualityActionId !== binding.actionId || contract.ref.sha256 !== uploaded.sha256
    || attachment.issueId !== binding.source.issueId
    || asset.provider !== uploaded.provider || asset.objectKey !== uploaded.objectKey
    || asset.contentType !== uploaded.contentType || asset.byteSize !== uploaded.byteSize
    || asset.sha256 !== uploaded.sha256 || asset.originalFilename !== uploaded.originalFilename) {
    return { ok: false, reason: "quality_use_receipt_binding_mismatch", detail: "use receipt scope, frozen expiry, or joined uploaded descriptor differs from the preparation" };
  }
  return { ok: true };
}

/** Complete payload and every related row are validated before a committed result is reused. */
export async function validateQaRemediationCompletionEvidence(db: Db, row: QaRemediationEventRow, p: QaRemediationPreparation):
Promise<{ ok: true; completion: QaRemediationCompletion } | { ok: false; reason: string; detail: string }> {
  if (row.eventType !== "qa_remediation_completed" || row.companyId !== p.companyId
    || row.missionId !== p.missionId || row.workflowRunId !== p.workflowRunId
    || row.workflowStepRunId !== p.producer.stepRunId || row.issueId !== p.producer.issueId
    || row.executionGeneration !== p.producer.executionGeneration || row.idempotencyKey !== qaRemediationCompletionKey(p)) {
    return { ok: false, reason: "row_binding_mismatch", detail: "completion event row columns do not bind this preparation scope" };
  }
  let completion: QaRemediationCompletion;
  try { completion = parseQaRemediationCompletion(row.payload); }
  catch (error) { return { ok: false, reason: "malformed_completion", detail: `payload fails the strict completion schema: ${error instanceof Error ? error.message : String(error)}` }; }
  const expectedVersion = p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
    ? QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3 : QA_REMEDIATION_COMPLETION_SCHEMA_VERSION;
  if (completion.schemaVersion !== expectedVersion || completion.preparationId !== p.preparationId
    || completion.completionId !== row.id || completion.companyId !== p.companyId || completion.missionId !== p.missionId
    || completion.workflowRunId !== p.workflowRunId || completion.dispatchAuthorityVersion !== p.dispatchAuthorityVersion
    || !same(completion.producer, p.producer)) {
    return { ok: false, reason: "payload_binding_mismatch", detail: "completion payload does not bind the exact preparation version/scope/authority/producer tuple" };
  }
  const used = new Set<number>();
  const verdictBinds = completion.verdicts.length === p.verdicts.length && completion.verdicts.every((verdict) => {
    const index = p.verdicts.findIndex((source, i) => !used.has(i) && source.eventId === verdict.eventId
      && source.heartbeatRunId === verdict.heartbeatRunId && source.remediationsHash === verdict.remediationsHash
      && same(source.qa, verdict.qa) && hashQaCorrectionPayload(source.items) === verdict.remediationsHash);
    if (index === -1) return false;
    used.add(index);
    return true;
  });
  if (!verdictBinds) return { ok: false, reason: "payload_binding_mismatch", detail: "completion verdicts are not the exact 1:1 duplicate-free preparation source set" };
  if (!qaRemediationSuccessfulPublicationFiles(p, completion.files)) {
    return { ok: false, reason: "file_coverage_mismatch", detail: "completion files are not the exact unique success-only cover of the reserved files" };
  }
  if (completion.schemaVersion === QA_REMEDIATION_COMPLETION_SCHEMA_VERSION_V3) {
    if (p.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
      return { ok: false, reason: "quality_binding_missing", detail: "workflow v2 preparation cannot own a Quality completion" };
    }
    const quality = await validateQualityUseEvidence(db, p, completion);
    if (!quality.ok) return quality;
  }

  const wakeRows = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, p.companyId),
    inArray(agentWakeupRequests.id, completion.wakes.map((wake) => wake.wakeupRequestId))));
  for (const wake of completion.wakes) {
    const verdict = p.verdicts.find((source) => source.eventId === wake.sourceVerdictEventId);
    const wakeRow = wakeRows.find((candidate) => candidate.id === wake.wakeupRequestId);
    if (!verdict || !wakeRow) return { ok: false, reason: "wake_evidence_missing", detail: `recorded wake ${wake.wakeupRequestId} has no exactly-bound live row/source verdict` };
    const rowBound = bindV2RefireWakeRow(wakeRow, verdict, p);
    if (!rowBound.ok) return rowBound;
    const receiptBound = bindWakeReceipt(wake, wakeRow, verdict);
    if (!receiptBound.ok) return receiptBound;
  }
  return { ok: true, completion };
}
