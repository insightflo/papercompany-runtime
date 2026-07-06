import { z } from "zod";

const workflowArtifactTypeSchema = z.enum(["artifact", "document"]);

export const workflowArtifactRegisterSchema = z.object({
  path: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  type: workflowArtifactTypeSchema.optional().default("artifact"),
  summary: z.string().trim().optional().nullable(),
  isPrimary: z.boolean().optional().default(true),
});

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
