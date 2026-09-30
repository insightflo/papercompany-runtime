import { z } from "zod";
import { issueWorkProductTypeSchema } from "./work-product.js";

export const workProductSelectorsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.object({
  type: issueWorkProductTypeSchema, title: z.string().min(1).max(255),
}).strict());
export type WorkProductSelectors = z.infer<typeof workProductSelectorsSchema>;

/** Explicit frozen definition contract, never inferred from a tool name or stdout. */
export const toolArtifactContractSchema = z.object({
  schemaVersion: z.literal("manual-onboarding.qa.v1"),
  role: z.literal("qa"),
  inputStepId: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type ToolArtifactContract = z.infer<typeof toolArtifactContractSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const workProductProducerSchema = z.object({
  schemaVersion: z.literal("workflow.work-product-producer.v1"), companyId: z.string().uuid(),
  missionId: z.string().uuid().nullable(), workflowRunId: z.string().uuid(), stepRunId: z.string().uuid(),
  stepId: z.string().min(1), executionGeneration: count, retryCount: count, iterationIndex: count,
  heartbeatRunId: z.string().uuid(),
}).strict();
export const assetDigestSchema = z.object({ fileName: z.string().min(1), sha256: hash, byteSize: count }).strict();
const check = z.object({ id: z.string().min(1), ok: z.boolean(), detail: z.unknown().optional(), problems: z.array(z.unknown()).optional() }).passthrough();
const qaBase = { schemaVersion: z.literal("manual-onboarding.qa.v1"), command: z.literal("qa"),
  section: z.string().nullable(), ok: z.boolean(), checks: z.array(check).min(1),
  checkedAt: z.string().datetime(), artifactPath: z.string() };
export const manualQaResultSchema = z.union([
  z.object({ ...qaBase, mode: z.literal("content"), contentSha256: hash, assetManifest: z.array(assetDigestSchema) }).strict(),
  z.object({ ...qaBase, mode: z.literal("html"), htmlPath: z.string(), htmlSha256: hash,
    assetManifest: z.array(assetDigestSchema), ancillaryManifest: z.array(assetDigestSchema) }).strict(),
]);
export const toolArtifactReceiptSchema = z.object({
  schemaVersion: z.literal("workflow.tool-artifact.v1"), role: z.literal("qa"),
  companyId: z.string().uuid(), missionId: z.string().uuid(), workflowRunId: z.string().uuid(),
  stepRunId: z.string().uuid(), stepId: z.string().min(1), executionGeneration: count, retryCount: count,
  iterationIndex: count, requestId: z.string().min(1), outputRoot: z.string().min(1), outputRootHash: hash,
  relativePath: z.literal("qa-result.json"), resultSchema: z.literal("manual-onboarding.qa.v1"),
  sha256: hash, byteSize: count, toolId: z.string().uuid(), toolName: z.string().min(1),
  toolDeployment: z.array(assetDigestSchema).min(1),
  input: z.object({ workProductId: z.string().uuid(), producer: workProductProducerSchema,
    path: z.string(), sha256: hash, byteSize: count, assetsRoot: z.string(), assetManifest: z.array(assetDigestSchema),
    mode: z.literal("html").optional(), htmlManifest: z.object({ path: z.string(), sha256: hash, byteSize: count }).strict().optional(),
    ancillaryManifest: z.array(assetDigestSchema).optional(),
  }).strict().refine(v => v.mode === "html" ? v.htmlManifest !== undefined && v.ancillaryManifest !== undefined
    : v.htmlManifest === undefined && v.ancillaryManifest === undefined),
}).strict();
export type ToolArtifactReceipt = z.infer<typeof toolArtifactReceiptSchema>;
