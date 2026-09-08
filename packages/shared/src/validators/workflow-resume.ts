import { z } from "zod";

/**
 * [purpose] 미션 재개 요청 본문 계약 — UI가 생성하는 유일한 POST /workflow-resume-requests 본문.
 * 승인 플랜(plan 문서 29-89행)과 동일. strict 스키마로 임의 필드(reset 목록/status/localPath 등)를 차단한다.
 */
export const resumeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("resume_from_step"),
    companyId: z.string().uuid(),
    missionId: z.string().uuid(),
    workflowRunId: z.string().uuid(),
    startStepId: z.string().min(1).max(200),
    snapshotToken: z.string().min(1).max(16384),
    idempotencyKey: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ResumeRequestBody = z.infer<typeof resumeRequestSchema>;

/**
 * [purpose] ResumeBlocker.code enum — server가 정한 승인 목록(plan 문서 확정분)으로 validator를 좁힌다.
 */
export const resumeBlockerCodes = [
  "historical_definition_unproven",
  "unsupported_graph",
  "unsupported_status",
  "active_work",
  "executed_step",
  "external_effect_unknown",
  "control_tool_effects_unverified",
  "publication_binding_unverified",
  "missing_evidence",
  "ambiguous_evidence",
  "outside_predecessor_invalid",
  "required_gate_bypass",
  "stale_snapshot",
  "budget_unknown",
  "budget_exceeded",
  "scope_mismatch",
] as const;

export const resumeBlockerCodeSchema = z.enum(resumeBlockerCodes);
export type ResumeBlockerCode = z.infer<typeof resumeBlockerCodeSchema>;
