import { and, eq, inArray, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";
import { activityLog, assets, issueAttachments, qualityActions, qualityEvidenceRefs,
  qualityOccurrences, qualityReviewItems } from "@paperclipai/db";
import { nativeBindingSchema, outputCorrectionScopeSchema, qualityEffectSchema, qualityTargetSchema,
  retryEnvelopeSchema, sourceAttemptSchema, STORAGE_PROVIDERS, uuidSchema,
  type ArtifactRef, type OutputCorrectionScope, type SourceAttempt } from "@paperclipai/shared";
import { type PutFileResult } from "../../storage/index.js";
import { evidenceContractSchema, evidenceError, hashContract, parseEvidence, type QualityTx } from "./contract.js";
import { readVerifiedEvidenceUpload } from "./evidence-store.js";
import { verifyEvidenceScope, verifySourceAttempt } from "./evidence-verifier.js";
import { hashQaCorrectionPayload, qaCorrectionAppliedSchema, qaCorrectionPreparationSchema,
  qaCorrectionSourceMeasuredSchema, type QaCorrectionApplied, type QaCorrectionPreparation,
  type QaCorrectionSourceMeasured } from "../workflow/control-flow/qa-correction-contract.js";
import type { MeasuredRef } from "../workflow/control-flow/qa-correction-measure.js";

type Revision = QaCorrectionApplied["revisions"][number] & {
  bundleManifestRelativePath: string | null; assetsRelativeRoot: string | null;
};
export type QaCorrectionUseEvidenceBinding = MeasuredRef & {
  schemaVersion: "workflow.qa-correction.use-evidence.v1"; kind: "use";
  issuedBy: "quality:current-output"; originalRef: null;
  companyId: string; correctionId: string; appliedEventId: string;
  preparation: QaCorrectionPreparation; revisions: Revision[];
  reviewItemId: string; actionId: string; source: SourceAttempt; scope: OutputCorrectionScope;
  expiresAt: string; beforeHash: string; revisionHash: string;
};
declare const preparedBrand: unique symbol;
export type PreparedQaCorrectionUseEvidence = { readonly [preparedBrand]: true };
type Prepared = {
  binding: QaCorrectionUseEvidenceBinding; uploaded: PutFileResult; body: Buffer; bytesVerifiedAt: number;
};
const preparedTokens = new WeakMap<PreparedQaCorrectionUseEvidence, Prepared>();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.use-evidence.v1"), kind: z.literal("use"),
  issuedBy: z.literal("quality:current-output"), originalRef: z.null(),
  companyId: uuidSchema, correctionId: uuidSchema, appliedEventId: uuidSchema,
  preparationEventId: uuidSchema, preparationHash: hash, preparation: qaCorrectionPreparationSchema,
  sourceMeasuredEventId: uuidSchema, sourceMeasuredHash: hash, sourceMeasured: qaCorrectionSourceMeasuredSchema,
  revisions: qaCorrectionAppliedSchema.innerType().shape.revisions,
  reviewItemId: uuidSchema, actionId: uuidSchema, source: sourceAttemptSchema, scope: outputCorrectionScopeSchema,
  expiresAt: z.string().datetime(), beforeHash: hash, revisionHash: hash,
}).strict();
const uploadedSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS), objectKey: z.string().min(1), contentType: z.string().min(1),
  byteSize: z.number().int().safe().positive(), sha256: hash, originalFilename: z.string().nullable(),
}).strict();
const prepareSchema = z.object({ binding: z.unknown(), uploaded: uploadedSchema }).strict();
function requireBinding(ok: unknown): asserts ok {
  if (!ok) evidenceError("quality_evidence_scope_mismatch");
}
function snapshot<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    // Reject accessors, exotic objects and non-JSON data before cloning or schema parsing.
    hashQaCorrectionPayload(value);
    return parseEvidence(schema, JSON.parse(JSON.stringify(value)));
  } catch { evidenceError("quality_evidence_invalid_contract"); }
}
const same = (a: unknown, b: unknown) => hashQaCorrectionPayload(a) === hashQaCorrectionPayload(b);
function checkedBinding(value: unknown): QaCorrectionUseEvidenceBinding {
  const b = snapshot(bindingSchema, value), p = b.preparation, m: QaCorrectionSourceMeasured = b.sourceMeasured;
  const a = p.authority, s = b.scope;
  requireBinding(a.kind === "quality_current_output");
  requireBinding(b.companyId === p.companyId && b.correctionId === p.correctionId
    && b.preparationEventId === p.correctionId && b.preparationHash === hashQaCorrectionPayload(p)
    && m.preparationEventId === b.preparationEventId && m.preparationHash === b.preparationHash
    && b.sourceMeasuredHash === hashQaCorrectionPayload(m)
    && new Set([b.preparationEventId, b.sourceMeasuredEventId, b.appliedEventId]).size === 3
    && Date.parse(m.measuredAt) >= Date.parse(p.preparedAt));
  requireBinding(b.actionId === a.actionId && b.reviewItemId === a.reviewItemId
    && b.companyId === b.source.companyId && same(b.source, a.source)
    && s.companyId === b.companyId && s.actionId === a.actionId && same(s.source, b.source)
    && s.verifierRunId === a.verifierRunId && s.verifierEpoch === a.verifierEpoch);
  const source = b.source;
  requireBinding(source.issueId === p.producer.issueId && source.mission.kind === "mission"
    && source.mission.id === p.missionId && source.workflow.kind === "workflow_step"
    && source.workflow.runId === p.workflowRunId && source.workflow.stepRunId === p.producer.stepRunId
    && source.workflow.generation === p.producer.executionGeneration
    && source.workflow.dispatchAuthorityVersion === p.dispatchAuthorityVersion
    && a.verdicts.some(v => v.heartbeatRunId === a.verifierRunId));
  requireBinding(m.sources.length === p.sources.length
    && m.sources.every(v => p.sources.some(original => original.productId === v.productId))
    && b.revisions.length === m.sources.length
    && new Set(b.revisions.map(r => r.sourceProductId)).size === b.revisions.length
    && new Set(b.revisions.map(r => r.revisionId)).size === b.revisions.length
    && new Set(b.revisions.map(r => r.workProductId)).size === b.revisions.length);
  for (const r of b.revisions) {
    requireBinding((r.bundleManifestRelativePath === null || typeof r.bundleManifestRelativePath === "string")
      && (r.assetsRelativeRoot === null || typeof r.assetsRelativeRoot === "string"));
    const before = m.sources.find(v => v.productId === r.sourceProductId);
    requireBinding(before && before.files.length === r.files.length
      && r.files.every(file => before.files.some(old => old.relativePath === file.relativePath
        && old.role === file.role && old.sha256 === file.beforeSha256)));
    requireBinding(!p.sources.some(original => original.productId === r.workProductId));
  }
  requireBinding(b.beforeHash === hashQaCorrectionPayload(m.sources)
    && b.revisionHash === hashQaCorrectionPayload(b.revisions));
  return b as QaCorrectionUseEvidenceBinding;
}

/** C03: exact server evidence body. This validates structure, never current authority or budget. */
export function encodeQaCorrectionUseEvidence(binding: QaCorrectionUseEvidenceBinding): Buffer {
  return Buffer.from(JSON.stringify(checkedBinding(binding)), "utf8");
}

/** Outside the transaction: copy everything before IO and verify the actual complete stored body. */
export async function prepareQaCorrectionUseEvidence(input: {
  binding: QaCorrectionUseEvidenceBinding; uploaded: PutFileResult;
}): Promise<PreparedQaCorrectionUseEvidence> {
  const copied = snapshot(prepareSchema, input), binding = checkedBinding(copied.binding);
  const uploaded = copied.uploaded, body = Buffer.from(JSON.stringify(binding), "utf8");
  const bytes = await readVerifiedEvidenceUpload(binding.companyId, uploaded);
  if (!bytes.equals(body)) evidenceError("quality_evidence_body_mismatch");
  const token = Object.freeze({}) as PreparedQaCorrectionUseEvidence;
  preparedTokens.set(token, { binding, uploaded, body, bytesVerifiedAt: Date.now() });
  return token;
}

/** No IO and no restoration, including when the caller rolls back or returns without linking. */
export function discardQaCorrectionUseEvidence(token: PreparedQaCorrectionUseEvidence): void {
  preparedTokens.delete(token);
}

async function verifyDbLinks(tx: QualityTx, b: QaCorrectionUseEvidenceBinding): Promise<void> {
  const p = b.preparation, a = p.authority;
  requireBinding(a.kind === "quality_current_output");
  const [review] = await tx.select().from(qualityReviewItems).where(and(
    eq(qualityReviewItems.companyId, b.companyId), eq(qualityReviewItems.id, b.reviewItemId)));
  const [action] = await tx.select().from(qualityActions).where(and(
    eq(qualityActions.companyId, b.companyId), eq(qualityActions.id, b.actionId)));
  requireBinding(review && action && action.kind === "current_output"
    && action.groupId === a.groupId && action.policyVersionId === a.policyVersionId && action.intentKey === a.intentKey);
  const target = parseEvidence(qualityTargetSchema, action.target);
  const effect = parseEvidence(qualityEffectSchema, action.effect);
  const envelope = parseEvidence(retryEnvelopeSchema, action.retryEnvelope);
  const binding = parseEvidence(nativeBindingSchema, action.canonicalBinding);
  requireBinding(target.kind === "current_output" && effect.kind === "repair_supported_output"
    && same(target.source, b.source) && hashContract(target) === action.targetHash && action.targetHash === a.targetHash
    && hashContract(effect) === action.effectHash && action.effectHash === a.effectHash
    && same(effect.target, target) && hashContract(envelope) === a.retryEnvelopeHash
    && envelope.deadlineAt === b.expiresAt && envelope.intentKey === a.intentKey
    && envelope.targetHash === a.targetHash && envelope.effectHash === a.effectHash
    && envelope.groupId === a.groupId && envelope.policyVersionId === a.policyVersionId);
  requireBinding(binding.companyId === b.companyId && binding.actionId === b.actionId
    && binding.missionId === p.missionId && binding.workflowRunId === p.workflowRunId
    && a.verdicts.some(v => v.heartbeatRunId === b.scope.verifierRunId
      && v.qa.stepRunId === binding.stepRunId && v.qa.issueId === binding.issueId));
  await verifySourceAttempt(tx, b.companyId, b.source);
  await verifyEvidenceScope(tx, b.companyId, b.scope);
  const occurrenceIds = parseEvidence(z.array(uuidSchema).min(1), action.occurrenceIds);
  const occurrences = await tx.select().from(qualityOccurrences).where(and(
    eq(qualityOccurrences.companyId, b.companyId), eq(qualityOccurrences.reviewItemId, b.reviewItemId),
    inArray(qualityOccurrences.id, occurrenceIds)));
  requireBinding(occurrences.some(o => o.producerRunId === b.source.heartbeatRunId && same(o.sourceBinding, b.source)));
}

/** C03: one consumption, DB-only writes in the caller's actual transaction. Never reserves budget. */
export async function linkPreparedQaCorrectionUseEvidence(tx: QualityTx, input: {
  token: PreparedQaCorrectionUseEvidence; expected: QaCorrectionUseEvidenceBinding;
}): Promise<{ ref: ArtifactRef; evidenceRefId: string; verifiedAt: string }> {
  const token = input.token, prepared = preparedTokens.get(token);
  preparedTokens.delete(token); // Consume synchronously even for mismatches, failed DB calls and rollback.
  if (!prepared || !is(tx, PgTransaction)) evidenceError("quality_evidence_token_invalid");
  const expected = checkedBinding(input.expected);
  requireBinding(Buffer.from(JSON.stringify(expected), "utf8").equals(prepared.body));
  const b = prepared.binding;
  await verifyDbLinks(tx, b);
  // Last relational check has completed. The caller must reuse this exact time for appliedAt.
  const now = Date.now(), verifiedAt = new Date(now).toISOString();
  if (now < prepared.bytesVerifiedAt || now < Date.parse(b.sourceMeasured.measuredAt)) {
    evidenceError("quality_evidence_time_reversed");
  }
  if (now >= Date.parse(b.expiresAt)) evidenceError("quality_evidence_expired");
  const [asset] = await tx.insert(assets).values({ companyId: b.companyId, ...prepared.uploaded })
    .returning({ id: assets.id });
  const [attachment] = await tx.insert(issueAttachments).values({
    companyId: b.companyId, issueId: b.source.issueId, assetId: asset.id,
  }).returning({ id: issueAttachments.id });
  const ref = { attachmentId: attachment.id, sha256: prepared.uploaded.sha256 };
  const contract = parseEvidence(evidenceContractSchema, {
    schemaVersion: 1, kind: b.kind, ref, source: b.source, scope: b.scope, issuedBy: b.issuedBy,
    verifiedAt, expiresAt: b.expiresAt, originalRef: b.originalRef,
  });
  const [receipt] = await tx.insert(qualityEvidenceRefs).values({
    companyId: b.companyId, reviewItemId: b.reviewItemId, qualityActionId: b.actionId,
    qualityContract: contract, surface: "attachment", status: "verified", sourceRunId: b.source.heartbeatRunId,
    collectedByActorType: "system", collectedByActorId: b.issuedBy, freshnessExpiresAt: new Date(b.expiresAt),
  }).returning({ id: qualityEvidenceRefs.id });
  await tx.insert(activityLog).values({
    companyId: b.companyId, actorType: "system", actorId: b.issuedBy, action: "quality.evidence_linked",
    entityType: "quality_evidence_ref", entityId: receipt.id,
    details: { reviewItemId: b.reviewItemId, attachmentId: ref.attachmentId, kind: b.kind,
      correctionId: b.correctionId, appliedEventId: b.appliedEventId },
  });
  return { ref, evidenceRefId: receipt.id, verifiedAt };
}
