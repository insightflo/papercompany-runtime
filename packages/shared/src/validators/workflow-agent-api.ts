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

/**
 * [verdict abstention] 공식 workflow QA 판정 값. insufficient_evidence = "지금 판단 불가 — 필요 자료 명시".
 *   pass/request_changes 만 완료 게이트를 만족시키며, insufficient_evidence 는 이벤트로 기록되지만
 *   게이트 만족 목록에서는 제외된다(missing-block 과 별개 사유로 blocked).
 */
export const workflowValidationVerdictValueSchema = z.enum([
  "pass",
  "request_changes",
  "insufficient_evidence",
]);
export type WorkflowValidationVerdictValue = z.infer<typeof workflowValidationVerdictValueSchema>;

/**
 * [qa defect layer] 공식 QA 판정의 구조화 결함 항목. layer 가 원천 결함(source_data) 인지
 *   산출물 결함(artifact) 인지에 따라 재작업 라우팅이 갈린다(loop-driver 계층 라우팅).
 *   verdict=request_changes 와 함께만 제출 가능하며, 자연어 comment/표면 텍스트는 절대 권위가 아니다.
 */
export const workflowVerdictFindingSchema = z.object({
  id: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(300),
  layer: z.enum(["source_data", "artifact"]),
});
export const workflowVerdictFindingsSchema = z.array(workflowVerdictFindingSchema).max(20);

export type WorkflowVerdictFinding = z.infer<typeof workflowVerdictFindingSchema>;

export const workflowVerdictSubmitSchema = z.object({
  verdict: workflowValidationVerdictValueSchema,
  reason: z.string().trim().optional().nullable(),
  nonblockingAcceptance: workflowNonblockingAcceptanceSchema.optional(),
  findings: workflowVerdictFindingsSchema.optional(),
}).superRefine((value, ctx) => {
  // [qa-cap acceptance] nonblocking 분류는 request_changes verdict 와만 공존.
  if (value.nonblockingAcceptance && value.verdict !== "request_changes") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nonblockingAcceptance"],
      message: "nonblockingAcceptance requires verdict=request_changes",
    });
  }
  // [qa defect layer] 결함 계층 findings 는 request_changes verdict 와만 공존.
  if (value.findings && value.verdict !== "request_changes") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "findings requires verdict=request_changes",
    });
  }
  // [verdict abstention] 보류 판정은 어떤 증거가 빠졌는지 reason 에 반드시 명시해야 한다.
  if (value.verdict === "insufficient_evidence") {
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (reason.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "reason is required when verdict=insufficient_evidence (state the missing evidence)",
      });
    }
  }
});

export const missionPlanQaVerdictSubmitSchema = z.object({
  verdict: z.enum(["pass", "request_changes"]),
  diagnostics: z.array(z.record(z.unknown())).optional().default([]),
});
export const missionOwnerPlanDecisionSubmitSchema = z.object({
  decision: z.record(z.unknown()),
});

export const workflowIssueCompleteSchema = z.object({
  comment: z.string().trim().optional().nullable(),
});

export type WorkflowArtifactRegister = z.infer<typeof workflowArtifactRegisterSchema>;
export type WorkflowNonblockingAcceptance = z.infer<typeof workflowNonblockingAcceptanceSchema>;
export type MissionPlanQaVerdictSubmit = z.infer<typeof missionPlanQaVerdictSubmitSchema>;
export type MissionOwnerPlanDecisionSubmit = z.infer<typeof missionOwnerPlanDecisionSubmitSchema>;
export type WorkflowVerdictSubmit = z.infer<typeof workflowVerdictSubmitSchema>;
export type WorkflowIssueComplete = z.infer<typeof workflowIssueCompleteSchema>;
export const missionOwnerDecisionOptionSchema = z.enum([
  "request_input",
  "retry_source_issue",
  "reassign_source_issue",
  "replan_mission",
  "escalate",
  "report_impossible",
  "recover_artifact",
  "no_action_waiting",
]);

// [structured authority] mission-owner recovery 결정의 유일한 실행 권위 제출 형태.
//   자연어 comment 는 더 이상 권위가 아니다 — 오직 이 구조 제출만 결정을 영속화한다.
export const missionOwnerDecisionSubmitSchema = z.object({
  decision: missionOwnerDecisionOptionSchema,
  sourceIssueRef: z.string().trim().optional().nullable(),
  reworkTargetRef: z.string().trim().optional().nullable(),
  // Typed reassignment target — free-text nextAction/reason/evidence UUID scraping is not authority.
  targetAgentId: z.string().uuid().optional().nullable(),
  reason: z.string().trim().max(2000).optional().nullable(),
  nextAction: z.string().trim().max(2000).optional().nullable(),
  evidence: z.string().trim().max(4000).optional().nullable(),
}).superRefine((value, ctx) => {
  // reassign_source_issue requires a same-company agent UUID; other decisions leave it optional.
  if (value.decision !== "reassign_source_issue") return;
  if (typeof value.targetAgentId === "string" && value.targetAgentId.length > 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["targetAgentId"],
    message: "targetAgentId is required when decision is reassign_source_issue",
  });
});

export type MissionOwnerDecisionOption = z.infer<typeof missionOwnerDecisionOptionSchema>;
export type MissionOwnerDecisionSubmit = z.infer<typeof missionOwnerDecisionSubmitSchema>;
