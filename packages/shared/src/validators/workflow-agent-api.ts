import { z } from "zod";

const workflowLocalArtifactTypeSchema = z.enum(["artifact", "document"]);

const workflowLocalArtifactRegisterSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  type: workflowLocalArtifactTypeSchema.optional().default("artifact"),
  summary: z.string().trim().optional().nullable(),
  isPrimary: z.boolean().optional().default(true),
});

const workflowPreviewUrlRegisterSchema = z.object({
  type: z.literal("preview_url"),
  url: z.string().trim().url(),
  title: z.string().trim().min(1).optional(),
  externalId: z.string().trim().min(1).optional(),
  expectedTitle: z.string().trim().min(1).optional(),
  contentMarker: z.string().trim().min(1).optional(),
  marker: z.string().trim().min(1).optional(),
  topic: z.string().trim().min(1).optional(),
  summary: z.string().trim().optional().nullable(),
  isPrimary: z.boolean().optional().default(true),
});

export const workflowArtifactRegisterSchema = z.union([
  workflowPreviewUrlRegisterSchema,
  workflowLocalArtifactRegisterSchema,
]);

export const workflowVerdictSubmitSchema = z.object({
  verdict: z.enum(["pass", "request_changes"]),
  reason: z.string().trim().optional().nullable(),
});

export const workflowIssueCompleteSchema = z.object({
  comment: z.string().trim().optional().nullable(),
});

export type WorkflowArtifactRegister = z.infer<typeof workflowArtifactRegisterSchema>;
export type WorkflowVerdictSubmit = z.infer<typeof workflowVerdictSubmitSchema>;
export type WorkflowIssueComplete = z.infer<typeof workflowIssueCompleteSchema>;
