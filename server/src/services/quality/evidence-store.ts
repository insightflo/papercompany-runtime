import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, assets, issueAttachments, qualityEvidenceRefs, qualityReviewItems, type Db } from "@paperclipai/db";
import { artifactRefSchema, evidenceScopeSchema, uuidSchema, type ArtifactRef, type EvidenceScope, type SourceAttempt } from "@paperclipai/shared";
import { getStorageService, type PutFileResult, type StorageService } from "../../storage/index.js";
import { HttpError } from "../../errors.js";
import { evidenceContractSchema, evidenceError, hashContract, parseEvidence, type EvidenceContract, type QualityDb, type QualityTx } from "./contract.js";
import { verifyEvidenceScope, verifySourceAttempt } from "./evidence-verifier.js";

/** Bytes only: call before opening the caller's transaction. No DB success receipt here. */
export async function uploadEvidence(storage: StorageService, input: {
  companyId: string; body: Buffer; contentType: string; originalFilename: string | null;
}): Promise<PutFileResult> {
  parseEvidence(uuidSchema, input.companyId);
  return storage.putFile({ ...input, namespace: "quality-evidence" });
}

/** [T6] 업로드된 bytes 를 회사 스코프 이슈 첨부로 기록한다(영수증 계약 없는 순수 첨부 저장). */
export async function attachEvidence(tx: QualityTx, input: {
  companyId: string; issueId: string; uploaded: PutFileResult;
}): Promise<ArtifactRef> {
  const [asset] = await tx.insert(assets).values({ companyId: input.companyId, ...input.uploaded }).returning({ id: assets.id });
  const [attachment] = await tx.insert(issueAttachments)
    .values({ companyId: input.companyId, issueId: input.issueId, assetId: asset!.id })
    .returning({ id: issueAttachments.id });
  return { attachmentId: attachment!.id, sha256: input.uploaded.sha256 };
}

/** [T6] 첨부 artifact bytes 를 다시 읽어 hash·크기를 검증한다(qualityEvidenceRefs 영수증 불요). */
const artifactReadInputSchema = z.object({
  companyId: uuidSchema, ref: artifactRefSchema,
  maxBytes: z.number().int().safe().positive(),
}).strict();

export async function readVerifiedArtifact(db: QualityDb, input: {
  companyId: string; ref: ArtifactRef; maxBytes: number;
}): Promise<Buffer> {
  const parsed = parseEvidence(artifactReadInputSchema, input);
  const [row] = await db.select({ asset: assets })
    .from(issueAttachments)
    .innerJoin(assets, and(eq(assets.companyId, parsed.companyId), eq(assets.id, issueAttachments.assetId)))
    .where(and(eq(issueAttachments.companyId, parsed.companyId), eq(issueAttachments.id, parsed.ref.attachmentId)))
    .limit(1);
  if (!row || row.asset.sha256 !== parsed.ref.sha256) evidenceError("quality_evidence_missing");
  return verifiedBytes(parsed.companyId, row.asset, parsed.maxBytes);
}

/** All three relational writes belong to the caller's transaction; never deletes orphan uploads. */
export async function linkEvidence(tx: QualityTx, input: {
  companyId: string; reviewItemId: string; source: SourceAttempt; scope: EvidenceScope | null;
  kind: EvidenceContract["kind"]; uploaded: PutFileResult; expiresAt: string | null;
  issuedBy: string; originalRef?: ArtifactRef | null;
}): Promise<{ ref: ArtifactRef; evidenceRefId: string }> {
  const { companyId, reviewItemId, uploaded } = input;
  const [review] = await tx.select({ id: qualityReviewItems.id }).from(qualityReviewItems).where(and(eq(qualityReviewItems.companyId, companyId), eq(qualityReviewItems.id, reviewItemId)));
  if (!review) evidenceError("quality_evidence_scope_mismatch");
  await verifySourceAttempt(tx, companyId, input.source);
  if (input.scope === null && input.kind !== "input") evidenceError("quality_evidence_invalid_contract");
  if (input.scope) await verifyEvidenceScope(tx, companyId, input.scope);
  if (input.scope?.kind === "output_correction" && hashContract(input.scope.source) !== hashContract(input.source)) evidenceError("quality_evidence_scope_mismatch");
  await verifiedBytes(companyId, uploaded, uploaded.byteSize);
  const [asset] = await tx.insert(assets).values({ companyId, ...uploaded }).returning({ id: assets.id });
  const issueId = input.scope === null ? input.source.issueId : input.scope.kind === "output_correction" ? input.scope.source.issueId : input.scope.issueId;
  const [attachment] = await tx.insert(issueAttachments).values({ companyId, issueId, assetId: asset.id }).returning({ id: issueAttachments.id });
  const ref = { attachmentId: attachment.id, sha256: uploaded.sha256 };
  const contract = parseEvidence(evidenceContractSchema, { schemaVersion: 1, kind: input.kind, ref, source: input.source, scope: input.scope, issuedBy: input.issuedBy, verifiedAt: new Date().toISOString(), expiresAt: input.expiresAt, originalRef: input.originalRef ?? null });
  if (contract.expiresAt && Date.parse(contract.expiresAt) <= Date.now()) evidenceError("quality_evidence_expired");
  if (contract.originalRef) {
    const original = await resolveEvidence(tx, companyId, contract.originalRef);
    if (contract.scope) await readEvidence(tx, { companyId, ref: contract.originalRef, scope: contract.scope, maxBytes: original.asset.byteSize });
    else await readSourceEvidence(tx, { companyId, ref: contract.originalRef, source: contract.source, maxBytes: original.asset.byteSize });
  }
  const [receipt] = await tx.insert(qualityEvidenceRefs).values({
    companyId, reviewItemId, qualityActionId: contract.scope && "actionId" in contract.scope ? contract.scope.actionId : null,
    qualityContract: contract, surface: "attachment", status: "verified", sourceRunId: contract.source.heartbeatRunId,
    collectedByActorType: "system", collectedByActorId: contract.issuedBy,
    freshnessExpiresAt: contract.expiresAt ? new Date(contract.expiresAt) : null,
  }).returning({ id: qualityEvidenceRefs.id });
  await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: contract.issuedBy, action: "quality.evidence_linked", entityType: "quality_evidence_ref", entityId: receipt.id, details: { reviewItemId, attachmentId: ref.attachmentId, kind: contract.kind } });
  return { ref, evidenceRefId: receipt.id };
}

const readInputSchema = z.object({ companyId: uuidSchema, ref: artifactRefSchema, scope: evidenceScopeSchema, maxBytes: z.number().int().safe().positive() }).strict();

export async function readEvidence(db: Db | QualityTx, input: {
  companyId: string; ref: ArtifactRef; scope: EvidenceScope; maxBytes: number;
}): Promise<Buffer> {
  const parsed = parseEvidence(readInputSchema, input);
  if (parsed.companyId !== parsed.scope.companyId) evidenceError("quality_scope_company_mismatch");
  const { receipt, contract, asset, attachment } = await resolveEvidence(db, parsed.companyId, parsed.ref);
  if (contract.scope === null) {
    // Pre-action input is bound to one exact source, never an execution-scope wildcard.
    if (parsed.scope.kind !== "output_correction" || hashContract(contract.source) !== hashContract(parsed.scope.source)) evidenceError("quality_evidence_scope_mismatch");
    await verifyEvidenceScope(db, parsed.companyId, parsed.scope);
    return readSourceEvidence(db, { companyId: parsed.companyId, ref: parsed.ref, source: parsed.scope.source, maxBytes: parsed.maxBytes });
  }
  if (hashContract(contract.scope) !== hashContract(parsed.scope)) evidenceError("quality_evidence_scope_mismatch");
  const issueId = parsed.scope.kind === "output_correction" ? parsed.scope.source.issueId : parsed.scope.issueId;
  if (attachment.issueId !== issueId || receipt.qualityActionId !== ("actionId" in parsed.scope ? parsed.scope.actionId : null)) evidenceError("quality_evidence_scope_mismatch");
  await verifySourceAttempt(db, parsed.companyId, contract.source);
  await verifyEvidenceScope(db, parsed.companyId, parsed.scope);
  return verifiedBytes(parsed.companyId, asset, parsed.maxBytes);
}

/** Scoped joins, not submitted URLs/paths or prose. Ambiguous receipt identity fails closed. */
export async function resolveEvidence(db: QualityDb, companyId: string, ref: ArtifactRef) {
  const rows = await db.select({ receipt: qualityEvidenceRefs, attachment: issueAttachments, asset: assets }).from(qualityEvidenceRefs)
    .innerJoin(qualityReviewItems, and(eq(qualityReviewItems.companyId, companyId), eq(qualityReviewItems.id, qualityEvidenceRefs.reviewItemId)))
    .innerJoin(issueAttachments, and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.id, ref.attachmentId)))
    .innerJoin(assets, and(eq(assets.companyId, companyId), eq(assets.id, issueAttachments.assetId)))
    .where(and(eq(qualityEvidenceRefs.companyId, companyId), sql`${qualityEvidenceRefs.qualityContract}->'ref'->>'attachmentId' = ${ref.attachmentId}`)).limit(2);
  if (!rows.length) evidenceError("quality_evidence_missing");
  if (rows.length !== 1) evidenceError("quality_evidence_ambiguous");
  const row = rows[0];
  const contract = parseEvidence(evidenceContractSchema, row.receipt.qualityContract);
  if (row.receipt.status === "archived") evidenceError("quality_evidence_archived");
  if (row.receipt.status !== "verified") evidenceError("quality_evidence_unverified");
  if ((row.receipt.freshnessExpiresAt && row.receipt.freshnessExpiresAt.getTime() <= Date.now()) || (contract.expiresAt && Date.parse(contract.expiresAt) <= Date.now())) evidenceError("quality_evidence_expired");
  if (contract.ref.sha256 !== ref.sha256 || row.asset.sha256 !== ref.sha256) evidenceError("quality_evidence_hash_mismatch");
  if ((contract.scope && contract.scope.companyId !== companyId) || contract.source.companyId !== companyId || row.receipt.sourceRunId !== contract.source.heartbeatRunId) evidenceError("quality_evidence_scope_mismatch");
  return { ...row, contract };
}

/** Source-only input capture before T3 creates an action. Not an execution acceptance API. */
export async function readSourceEvidence(db: QualityDb, input: {
  companyId: string; ref: ArtifactRef; source: SourceAttempt; maxBytes: number;
}) {
  const { receipt, contract, asset, attachment } = await resolveEvidence(db, input.companyId, input.ref);
  if (contract.kind !== "input" || contract.scope !== null || receipt.qualityActionId !== null || attachment.issueId !== input.source.issueId || hashContract(contract.source) !== hashContract(input.source)) evidenceError("quality_evidence_scope_mismatch");
  await verifySourceAttempt(db, input.companyId, input.source);
  return verifiedBytes(input.companyId, asset, input.maxBytes);
}

async function verifiedBytes(companyId: string, object: { provider: string; objectKey: string; byteSize: number; sha256: string }, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) evidenceError("quality_evidence_invalid_contract");
  if (!Number.isSafeInteger(object.byteSize) || object.byteSize < 1) evidenceError("quality_evidence_invalid_contract");
  if (object.byteSize > maxBytes) evidenceError("quality_evidence_too_large");
  const storage = getStorageService();
  if (object.provider !== storage.provider) evidenceError("quality_evidence_provider_mismatch");
  let stream: Awaited<ReturnType<StorageService["getObject"]>>["stream"] | undefined;
  try {
    const result = await storage.getObject(companyId, object.objectKey);
    stream = result.stream;
    if (result.contentLength !== undefined && result.contentLength > maxBytes) evidenceError("quality_evidence_too_large");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) evidenceError("quality_evidence_too_large");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    if (size !== object.byteSize || createHash("sha256").update(bytes).digest("hex") !== object.sha256) evidenceError("quality_evidence_hash_mismatch");
    return bytes;
  } catch (error) {
    if (error instanceof HttpError && error.message.startsWith("quality_")) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error instanceof HttpError && error.status === 404)) evidenceError("quality_evidence_missing");
    evidenceError("quality_evidence_unavailable");
  } finally { stream?.destroy(); }
}
