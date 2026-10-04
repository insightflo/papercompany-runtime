import { z } from "zod";
import { workProductProducerSchema } from "./workflow-artifact.js";
import { issueWorkProductTypeSchema } from "./work-product.js";

export const workflowSeedRequestSchema = z.object({
  sourceWorkflowRunId: z.string().uuid(),
  stepIds: z.array(z.string().min(1).max(255)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate seed step"),
}).strict();
export type WorkflowSeedRequest = z.infer<typeof workflowSeedRequestSchema>;

/** [Q11] 승인 때 서버가 렌더한 실제 해석 인자 바인딩 — 물화 재검증 대상(원본 run 좌표). */
export const workflowSeedInterpretedInputsSchema = z.object({
  schemaVersion: z.literal("workflow.seed.interpreted-inputs.v1"),
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  references: z.array(z.object({
    stepId: z.string().min(1), workProductId: z.string().uuid(), path: z.string().min(1),
  }).strict()),
  metadataValues: z.record(z.string(), z.string()),
}).strict();
export type WorkflowSeedInterpretedInputs = z.infer<typeof workflowSeedInterpretedInputsSchema>;

export const workflowSeedEvidenceSchema = z.object({
  schemaVersion: z.literal("workflow.seed.v1"),
  sourceDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  stepConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  stepConfigHashVersion: z.literal(2),
  products: z.array(z.object({
    id: z.string().uuid(), type: issueWorkProductTypeSchema, title: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1),
    producer: workProductProducerSchema,
  }).strict()).min(1),
  interpretedInputs: workflowSeedInterpretedInputsSchema.optional(),
}).strict();

/** Native tool-step output seed: the durable artifact record replaces issue work products. */
export const workflowSeedToolOutputSchema = z.object({
  schemaVersion: z.literal("workflow.seed.tool-output.v1"),
  sourceDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  stepConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  stepConfigHashVersion: z.literal(2),
  artifact: z.object({
    stepRunId: z.string().uuid(),
    requestId: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().nonnegative(),
    executionGeneration: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    iterationIndex: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type WorkflowSeedToolOutput = z.infer<typeof workflowSeedToolOutputSchema>;
