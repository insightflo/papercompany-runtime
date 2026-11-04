import path from "node:path";
import { z } from "zod";
import {
  nativeBindingSchema, retryEnvelopeSchema, sha256HexSchema, sourceAttemptSchema, STORAGE_PROVIDERS, uuidSchema,
} from "@paperclipai/shared";
import { hashContract } from "../../quality/contract.js";

const count = z.number().int().safe().nonnegative();
const text = z.string().min(1);
const canonicalFile = text.refine((file) => path.isAbsolute(file) && path.resolve(file) === file,
  "qa_remediation_quality_file_not_canonical");

export const qaRemediationQualityBindingSchema = z.object({
  kind: z.literal("quality_current_output"),
  actionId: uuidSchema,
  groupId: uuidSchema,
  policyVersionId: uuidSchema,
  intentKey: z.string().min(1).max(200),
  targetHash: sha256HexSchema,
  effectHash: sha256HexSchema,
  retryEnvelopeHash: sha256HexSchema,
  source: sourceAttemptSchema,
  sourceAttemptHash: sha256HexSchema,
  canonicalBinding: nativeBindingSchema,
  reviewItemId: uuidSchema,
  verifierRunId: uuidSchema,
  verifierEpoch: count,
  fileHashes: z.array(z.object({ file: canonicalFile, before: sha256HexSchema, after: sha256HexSchema }).strict())
    .min(1).refine((files) => new Set(files.map((file) => file.file)).size === files.length, "qa_remediation_quality_duplicate_file"),
  uploadedEvidence: z.object({
    provider: z.enum(STORAGE_PROVIDERS), objectKey: text, contentType: text, byteSize: count,
    sha256: sha256HexSchema, originalFilename: text,
  }).strict(),
  expiresAt: retryEnvelopeSchema.shape.deadlineAt,
}).strict();

export type QaRemediationQualityBinding = z.infer<typeof qaRemediationQualityBindingSchema>;

type PreparationIdentity = {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  dispatchAuthorityVersion: number;
  producer: { stepRunId: string; issueId: string; executionGeneration: number };
  verdicts: readonly { heartbeatRunId: string; qa: { stepRunId: string; issueId: string } }[];
  files: readonly { path: string; afterSha256: string }[];
};

/** Pure relationship checks only; a valid binding is recorded evidence, never execution authority. */
export function qualityBindingMatchesPreparation(binding: QaRemediationQualityBinding, p: PreparationIdentity): boolean {
  const source = binding.source, workflow = source.workflow, mission = source.mission;
  if (hashContract(source) !== binding.sourceAttemptHash
    || source.companyId !== p.companyId || source.issueId !== p.producer.issueId
    || mission.kind !== "mission" || mission.id !== p.missionId
    || workflow.kind !== "workflow_step" || workflow.runId !== p.workflowRunId
    || workflow.stepRunId !== p.producer.stepRunId || workflow.generation !== p.producer.executionGeneration
    || workflow.dispatchAuthorityVersion !== p.dispatchAuthorityVersion) return false;

  const native = binding.canonicalBinding;
  if (native.companyId !== p.companyId || native.actionId !== binding.actionId
    || native.missionId !== p.missionId || native.workflowRunId !== p.workflowRunId) return false;
  const qa = p.verdicts.filter((v) => v.qa.stepRunId === native.stepRunId && v.qa.issueId === native.issueId);
  if (qa.length !== 1 || qa[0]!.heartbeatRunId !== binding.verifierRunId) return false;

  const hashes = new Map(binding.fileHashes.map((file) => [file.file, file.after]));
  return hashes.size === p.files.length && p.files.every((file) => hashes.get(file.path) === file.afterSha256);
}

export function qaRemediationQualityBindingHash(binding: QaRemediationQualityBinding): string {
  return hashContract(binding);
}
