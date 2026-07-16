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

/**
 * [qa-cap acceptance] cap 도달 시 수용용 공식 분류. verdict=request_changes 와 함께만 제출 가능.
 *   classification 은 항상 "nonblocking" 이고, limitations 는 bounded nonempty 배열: 원소당
 *   trim 후 1..500 자, 배열 길이 1..20. comment/transcript/stdout/heartbeat prose 추론 ❌ —
 *   오직 이 공식 API body 만 인정(request_changes 전용).
 */
export const WORKFLOW_NONBLOCKING_LIMITATION_MAX_LENGTH = 500;
export const WORKFLOW_NONBLOCKING_LIMITATION_MAX_ITEMS = 20;

export const workflowNonblockingAcceptanceSchema = z.object({
  classification: z.literal("nonblocking"),
  limitations: z
    .array(z.string().trim().min(1).max(WORKFLOW_NONBLOCKING_LIMITATION_MAX_LENGTH))
    .min(1)
    .max(WORKFLOW_NONBLOCKING_LIMITATION_MAX_ITEMS),
});

export const workflowVerdictSubmitSchema = z.object({
  verdict: z.enum(["pass", "request_changes"]),
  reason: z.string().trim().optional().nullable(),
  nonblockingAcceptance: workflowNonblockingAcceptanceSchema.optional(),
}).refine(
  (value) => !value.nonblockingAcceptance || value.verdict === "request_changes",
  { message: "nonblockingAcceptance requires verdict=request_changes" },
);

export const missionPlanQaVerdictSubmitSchema = z.object({
  verdict: z.enum(["pass", "request_changes"]),
  diagnostics: z.array(z.record(z.unknown())).optional().default([]),
});

export const workflowIssueCompleteSchema = z.object({
  comment: z.string().trim().optional().nullable(),
});

export type WorkflowArtifactRegister = z.infer<typeof workflowArtifactRegisterSchema>;
export type WorkflowNonblockingAcceptance = z.infer<typeof workflowNonblockingAcceptanceSchema>;
export type MissionPlanQaVerdictSubmit = z.infer<typeof missionPlanQaVerdictSubmitSchema>;
export type WorkflowVerdictSubmit = z.infer<typeof workflowVerdictSubmitSchema>;
export type WorkflowIssueComplete = z.infer<typeof workflowIssueCompleteSchema>;
