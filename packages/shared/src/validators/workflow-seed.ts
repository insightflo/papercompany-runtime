import { z } from "zod";
import { workProductProducerSchema } from "./workflow-artifact.js";
import { issueWorkProductTypeSchema } from "./work-product.js";

export const workflowSeedRequestSchema = z.object({
  sourceWorkflowRunId: z.string().uuid(),
  stepIds: z.array(z.string().min(1).max(255)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate seed step"),
}).strict();
export type WorkflowSeedRequest = z.infer<typeof workflowSeedRequestSchema>;

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
