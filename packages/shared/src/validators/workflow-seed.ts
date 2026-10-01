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
