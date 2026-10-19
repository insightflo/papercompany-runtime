import { z } from "zod";
import { retryEnvelopeSchema } from "@paperclipai/shared";
import { getStorageService } from "../../../storage/index.js";
import { hashContract } from "../../quality/contract.js";
import { uploadEvidence } from "../../quality/evidence-store.js";
import { discardQaCorrectionUseEvidence, encodeQaCorrectionUseEvidence, prepareQaCorrectionUseEvidence,
  type PreparedQaCorrectionUseEvidence, type QaCorrectionUseEvidenceBinding } from "../../quality/qa-correction-use-evidence.js";
import { requireQaCorrection } from "./qa-correction-authority.js";
import { qaCorrectionCommitDetails, type ValidatedQaCorrectionCandidate } from "./qa-correction-commit-validation.js";

export type PreparedQaCorrectionCommitQualityUse = {
  token: PreparedQaCorrectionUseEvidence;
  binding: QaCorrectionUseEvidenceBinding;
  discard(): void;
};

/** C03 stage 3: storage IO only. The writer chooses appliedEventId once; retries/history belong to it.
 * A returned token proves a complete evidence read, not current permission or final issuance.
 * Call rereadQaCorrectionCommitSources after this, then final withCurrent + current assertion.
 * Link use first and reuse its verifiedAt for all atomic writes and the same-TX historical read.
 */
export async function prepareQaCorrectionCommitQualityUse(
  validation: ValidatedQaCorrectionCandidate, appliedEventId: string,
): Promise<PreparedQaCorrectionCommitQualityUse | null> {
  const d = qaCorrectionCommitDetails(validation), p = d.preparation, a = p.authority;
  if (a.kind !== "quality_current_output") return null; // No quality storage access in the ordinary path.
  const applied = z.string().uuid().parse(appliedEventId);
  const envelope = retryEnvelopeSchema.parse(d.current.retryEnvelope);
  requireQaCorrection(hashContract(envelope) === a.retryEnvelopeHash && envelope.intentKey === a.intentKey
    && envelope.targetHash === a.targetHash && envelope.effectHash === a.effectHash
    && envelope.groupId === a.groupId && envelope.policyVersionId === a.policyVersionId, "quality");
  const binding: QaCorrectionUseEvidenceBinding = {
    schemaVersion: "workflow.qa-correction.use-evidence.v1", kind: "use", issuedBy: "quality:current-output",
    originalRef: null, companyId: p.companyId, correctionId: p.correctionId, appliedEventId: applied,
    ...d.measured, preparation: p, revisions: d.stored.revisions,
    reviewItemId: a.reviewItemId, actionId: a.actionId, source: a.source,
    scope: { kind: "output_correction", companyId: p.companyId, actionId: a.actionId,
      source: a.source, verifierRunId: a.verifierRunId, verifierEpoch: a.verifierEpoch },
    expiresAt: envelope.deadlineAt, beforeHash: d.beforeHash, revisionHash: d.revisionHash,
  };
  const body = encodeQaCorrectionUseEvidence(binding);
  const uploaded = await uploadEvidence(getStorageService(), { companyId: p.companyId,
    body, contentType: "application/json", originalFilename: "qa-correction-use.json" });
  // This API rereads the complete configured storage object before allocating its single-use token.
  // Failures propagate; preparation/reservation stay intact and orphan uploads are never deleted.
  const token = await prepareQaCorrectionUseEvidence({ binding, uploaded });
  return Object.freeze({ token, binding, discard: () => discardQaCorrectionUseEvidence(token) });
}
