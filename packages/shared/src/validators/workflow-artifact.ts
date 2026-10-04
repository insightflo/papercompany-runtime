import { z } from "zod";
import { issueWorkProductTypeSchema } from "./work-product.js";
import { artifactFileNameSchema, artifactRoleSchema, artifactSchemaVersionSchema, type ArtifactContract } from "./artifact-contract.js";

export const workProductSelectorsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.object({
  type: issueWorkProductTypeSchema, title: z.string().min(1).max(255),
}).strict());
export type WorkProductSelectors = z.infer<typeof workProductSelectorsSchema>;

/** Explicit frozen definition contract, never inferred from a tool name or stdout. */
export const toolArtifactContractSchema = z.object({
  schemaVersion: artifactSchemaVersionSchema,
  role: artifactRoleSchema,
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
/**
 * [producer provenance rebind] 보드 승인으로 “생산 이후 생산자가 변하지 않았음”을 증명한 흔적.
 * fromGeneration 은 실제 생산 세대(변경 불가 원본 사실)이고, 재바인딩은 이후 어느 세대에서든
 * 유효하다(회복/재발사가 세대를 진행시켜도 무효화되지 않는다). 소비 시점마다 sha256/byteSize 로
 * 바이트 동일성이 재검증된다(workproduct-same-run).
 */
export const workProductProducerRebindMarkerSchema = z.object({
  schemaVersion: z.literal("workflow.work-product-producer-rebind.v1"),
  fromGeneration: count,
  reboundAtGeneration: count,
  fromHeartbeatRunId: z.string().uuid(),
  sha256: hash, byteSize: count,
  reboundAt: z.string().datetime(),
  reboundBy: z.object({ actorType: z.string().min(1), actorId: z.string().min(1) }).strict(),
  reason: z.string().min(1),
  authorityIdempotencyKey: z.string().min(1),
}).strict();
export type WorkProductProducerRebindMarker = z.infer<typeof workProductProducerRebindMarkerSchema>;
export const assetDigestSchema = z.object({ fileName: z.string().min(1), sha256: hash, byteSize: count }).strict();
const check = z.object({ id: z.string().min(1), ok: z.boolean(), detail: z.unknown().optional(), problems: z.array(z.unknown()).optional() }).passthrough();
const qaBase = { schemaVersion: artifactSchemaVersionSchema, command: z.literal("qa"),
  section: z.string().nullable(), ok: z.boolean(), checks: z.array(check).min(1),
  checkedAt: z.string().datetime(), artifactPath: z.string() };
export const manualQaResultSchema = z.union([
  z.object({ ...qaBase, mode: z.literal("content"), contentSha256: hash, assetManifest: z.array(assetDigestSchema) }).strict(),
  z.object({ ...qaBase, mode: z.literal("html"), htmlPath: z.string(), htmlSha256: hash,
    assetManifest: z.array(assetDigestSchema), ancillaryManifest: z.array(assetDigestSchema) }).strict(),
]);
export const qaCheckSchema = z.object({ id: z.string().min(1), ok: z.boolean(),
  severity: z.enum(["error", "warning"]).optional(), detail: z.unknown().optional() }).strict();
export const workflowQaResultSchema = z.object({
  schemaVersion: z.literal("workflow.qa-result.v1"), ok: z.boolean(), checks: z.array(qaCheckSchema).min(1),
  inputDigest: z.object({ sha256: hash, mode: z.enum(["content", "html"]).optional() }).strict(),
  assetManifest: z.array(assetDigestSchema).optional(), ancillaryManifest: z.array(assetDigestSchema).optional(),
}).strict();
export type WorkflowQaResult = z.infer<typeof workflowQaResultSchema>;
export type QaCheck = z.infer<typeof qaCheckSchema>;

/** Call only on machine-channel JSON; the declared schema must match before adaptation. */
export function adaptQaResult(raw: unknown, contract: Pick<ArtifactContract, "resultSchemaVersion" | "resultAdapter">): WorkflowQaResult {
  if (!raw || typeof raw !== "object" || !("schemaVersion" in raw) || raw.schemaVersion !== contract.resultSchemaVersion) {
    throw new Error("qa_result_schema_mismatch");
  }
  if (contract.resultAdapter === "generic") return workflowQaResultSchema.parse(raw);
  if (contract.resultAdapter !== "legacy-qa") throw new Error("qa_result_adapter_invalid");
  const legacy = manualQaResultSchema.parse(raw);
  return workflowQaResultSchema.parse({ schemaVersion: "workflow.qa-result.v1", ok: legacy.ok,
    checks: legacy.checks.map(({ id, ok, detail }) => ({ id, ok, ...(detail !== undefined ? { detail } : {}) })),
    inputDigest: { sha256: legacy.mode === "html" ? legacy.htmlSha256 : legacy.contentSha256, mode: legacy.mode },
    assetManifest: legacy.assetManifest, ...(legacy.mode === "html" ? { ancillaryManifest: legacy.ancillaryManifest } : {}),
  });
}

const receiptBase = z.object({
  role: artifactRoleSchema,
  companyId: z.string().uuid(), missionId: z.string().uuid(), workflowRunId: z.string().uuid(),
  stepRunId: z.string().uuid(), stepId: z.string().min(1), executionGeneration: count, retryCount: count,
  iterationIndex: count, requestId: z.string().min(1), outputRoot: z.string().min(1), outputRootHash: hash,
  relativePath: artifactFileNameSchema, resultSchema: artifactSchemaVersionSchema,
  sha256: hash, byteSize: count, toolId: z.string().uuid(), toolName: z.string().min(1),
  toolDeployment: z.array(assetDigestSchema).min(1),
  input: z.object({ workProductId: z.string().uuid(), producer: workProductProducerSchema,
    path: z.string(), sha256: hash, byteSize: count, assetsRoot: z.string(), assetManifest: z.array(assetDigestSchema),
    mode: z.literal("html").optional(), htmlManifest: z.object({ path: z.string(), sha256: hash, byteSize: count }).strict().optional(),
    ancillaryManifest: z.array(assetDigestSchema).optional(),
  }).strict().refine(v => v.mode === "html" ? v.htmlManifest !== undefined && v.ancillaryManifest !== undefined
    : v.htmlManifest === undefined && v.ancillaryManifest === undefined),
}).strict();
export const toolArtifactReceiptSchema = z.discriminatedUnion("schemaVersion", [
  receiptBase.extend({ schemaVersion: z.literal("workflow.tool-artifact.v1") }),
  receiptBase.extend({ schemaVersion: z.literal("workflow.tool-artifact.v2"), contractHash: hash, qaConfigHash: hash,
    runtimeChecks: z.array(qaCheckSchema).optional(), pluginChecks: z.array(qaCheckSchema).optional() }),
]);
export type ToolArtifactReceipt = z.infer<typeof toolArtifactReceiptSchema>;
