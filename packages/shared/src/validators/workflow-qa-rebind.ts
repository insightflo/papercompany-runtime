import { z } from "zod";
import { assetDigestSchema } from "./workflow-artifact.js";

export const workflowQaRebindClassificationSchema = z.enum(["auto_eligible", "card_required", "blocked", "excluded"]);
export const workflowQaRebindStatusSchema = z.enum([
  "candidate", "auto_eligible", "card_required", "blocked", "excluded", "claimed", "recovered", "dismissed",
]);
export const workflowQaRebindReasonSchema = z.enum([
  "generation_only", "failure_cascade_skipped", "receipt_v1_no_contract_hash", "receipt_scope_mismatch",
  "receipt_unavailable", "contract_invalid", "frozen_digest_mismatch", "publication_unproven",
  "published_same_qa", "producer_unproven", "producer_bytes_mismatch", "candidate_target_changed",
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowQaRebindExpectedDigestsSchema = z.object({
  workProductId: z.string().uuid(), sha256: hash, byteSize: z.number().int().nonnegative(),
  assetManifest: z.array(assetDigestSchema), htmlManifest: z.object({
    path: z.string(), sha256: hash, byteSize: z.number().int().nonnegative(),
  }).strict().nullable(), ancillaryManifest: z.array(assetDigestSchema),
  qaReceiptSha256: hash, contractHash: hash.nullable(), qaConfigHash: hash.nullable(),
}).strict();
export const workflowQaRebindClassificationResultSchema = z.object({
  schemaVersion: z.literal("workflow.qa-rebind-classification.v1"),
  status: workflowQaRebindClassificationSchema, reasonCode: workflowQaRebindReasonSchema,
  bundleDigest: hash, expectedDigests: workflowQaRebindExpectedDigestsSchema.nullable(),
  authorityVersion: z.number().int().nonnegative(), executionGeneration: z.number().int().nonnegative(),
}).strict();
export type WorkflowQaRebindClassification = z.infer<typeof workflowQaRebindClassificationSchema>;
export type WorkflowQaRebindStatus = z.infer<typeof workflowQaRebindStatusSchema>;
export type WorkflowQaRebindExpectedDigests = z.infer<typeof workflowQaRebindExpectedDigestsSchema>;
export type WorkflowQaRebindClassificationResult = z.infer<typeof workflowQaRebindClassificationResultSchema>;
