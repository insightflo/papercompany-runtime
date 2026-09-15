import { z } from "zod";
import { artifactRefSchema, sourceAttemptSchema, uuidSchema } from "./quality-automation.js";
import { checkResultSchema, evaluationScopeSchema } from "./quality-evaluation.js";

/** PLAN-QA 스코프 계약(설계 §3.2 PlanQaScope). Applicability/AddendumCheck는 quality-automation에 있다. */

const nonNegativeInteger = z.number().int().safe().min(0);

export const planQaScopeSchema = z.object({
  kind: z.literal("plan_qa"),
  companyId: uuidSchema,
  missionId: uuidSchema,
  planArtifactId: uuidSchema,
  issueId: uuidSchema,
  decisionHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
  manifestRef: artifactRefSchema,
  reviewGeneration: nonNegativeInteger,
  heartbeatRunId: uuidSchema,
  executionEpoch: nonNegativeInteger,
  workflow: z.object({
    kind: z.literal("not_applicable"),
    reason: z.literal("mission_plan_qa_issue"),
  }).strict(),
}).strict();
export type PlanQaScope = z.infer<typeof planQaScopeSchema>;

/** [기존 quality-execution.ts 에서 이동] output correction scope(plan-qa 와 같은 evidence scope 결합). */
export const outputCorrectionScopeSchema = z.object({
  kind: z.literal("output_correction"),
  companyId: uuidSchema,
  actionId: uuidSchema,
  source: sourceAttemptSchema,
  verifierRunId: uuidSchema,
  verifierEpoch: nonNegativeInteger,
}).strict().refine((scope) => scope.companyId === scope.source.companyId, "quality_scope_company_mismatch");
export type OutputCorrectionScope = z.infer<typeof outputCorrectionScopeSchema>;

/** [기존 quality-execution.ts 에서 이동] 증거 scope 결합(dispatch 계약이 같은 모듈에서 필요). */
export const evidenceScopeSchema = z.union([
  evaluationScopeSchema,
  planQaScopeSchema,
  outputCorrectionScopeSchema,
]);
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

/** [기존 quality-execution.ts 에서 이동] 증거 읽기·제출·실행 계약(설계 §3.2 MissingEvidence). */
export const missingEvidenceSchema = z.object({
  status: z.literal("missing_evidence"),
  scope: evidenceScopeSchema,
  reasons: z.array(z.object({
    code: z.string().min(1).max(200),
    checkId: z.string().min(1).max(200).nullable(),
    requiredKind: z.string().min(1).max(200),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256").nullable(),
  }).strict()).min(1),
  submission: z.object({
    method: z.literal("POST"),
    path: z.string().min(1).max(2_000),
    schemaVersion: nonNegativeInteger,
  }).strict(),
  remainingResubmissions: nonNegativeInteger,
}).strict();
export type MissingEvidence = z.infer<typeof missingEvidenceSchema>;

/** [T8 bounded resubmission] 검토 시도별 재제출 예약 원장 한 건. 예약 전에 정확한
 * MissingEvidence 문서와 현재 scope 고정 값이 함께 저장되고, wake 수락 판정은 이
 * 원장의 intentKey 일치로만 허용된다(콜백·행 존재만으로 수락 아님). */
export const planQaResubmissionDispatchSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("plan_qa_resubmission_dispatch"),
  attempt: z.number().int().safe().min(1),
  intentKey: z.string().min(1).max(300),
  missingEvidence: missingEvidenceSchema,
  policyVersionId: uuidSchema.nullable(),
  policyDefinitionSha256: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256").nullable(),
  maxResubmissions: nonNegativeInteger,
  dispatchedAt: z.string().datetime(),
  /** 실행 권위 호출 후 디스패처가 기록하는 표식(콜백 반환값이 아니다). null = 아직 요청 안 됨. */
  requestedAt: z.string().datetime().nullable(),
}).strict();
export type PlanQaResubmissionDispatch = z.infer<typeof planQaResubmissionDispatchSchema>;

/** [T8] 기존 /mission-plan-qa/verdict 제출의 strict v2 확장. schemaVersion 없으면 구형(v1) 본문이다. */
export const missionPlanQaVerdictSubmitV2Schema = z.object({
  verdict: z.enum(["pass", "request_changes"]),
  diagnostics: z.array(z.record(z.unknown())).optional().default([]),
  schemaVersion: z.literal(2).optional(),
  checks: z.array(checkResultSchema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.checks && value.schemaVersion !== 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_schema_version_required" });
  }
  if (value.checks && new Set(value.checks.map((check) => check.checkId)).size !== value.checks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_duplicate_entry" });
  }
});
export type MissionPlanQaVerdictSubmitV2 = z.infer<typeof missionPlanQaVerdictSubmitV2Schema>;

export const planQaCheckReadSchema = z.object({
  checkId: z.string().min(1).max(200),
  pointers: z.array(z.string().min(1).max(512)).min(1).max(16),
}).strict();
export type PlanQaCheckReadInput = z.infer<typeof planQaCheckReadSchema>;

/** [T8] mission_plan_qa_verdicts.qualityContract 저장 계약(시도별 원문은 불변 attachment). */
export const planQaReadRecordSchema = z.object({
  readRef: artifactRefSchema,
  pointers: z.array(z.string()),
  values: z.array(z.unknown()),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
}).strict();
export type PlanQaReadRecord = z.infer<typeof planQaReadRecordSchema>;

export const planQaGateCheckStatusSchema = z.object({
  checkId: z.string().min(1).max(200),
  status: z.enum(["satisfied", "defect", "insufficient_evidence", "execution_error", "excluded"]),
}).strict();

export const planQaGateDefectSchema = z.object({
  checkId: z.string().min(1).max(200),
  requirementRefs: z.array(artifactRefSchema),
  templateId: uuidSchema,
}).strict();

export const planQaGateVerdictSchema = z.object({
  status: z.enum(["pass", "request_changes"]),
  baseVerdict: z.enum(["pass", "request_changes"]),
  scope: planQaScopeSchema,
  checkStatuses: z.array(planQaGateCheckStatusSchema),
  defects: z.array(planQaGateDefectSchema),
  submissionRef: artifactRefSchema,
  receiptRef: artifactRefSchema,
  evidenceRefId: uuidSchema,
  verifiedAt: z.string().datetime(),
}).strict();
export type PlanQaGateVerdict = z.infer<typeof planQaGateVerdictSchema>;

export const planQaVerdictStateSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("plan_qa_verdict_v2"),
  scope: planQaScopeSchema,
  reads: z.record(z.string(), planQaReadRecordSchema),
  resubmissions: nonNegativeInteger,
  /** [T8 bounded resubmission] 시도·scope 변경과 무관하게 누적되는 예약 원장. */
  dispatches: z.array(planQaResubmissionDispatchSchema).default([]),
  baseVerdict: z.object({ status: z.enum(["pass", "request_changes"]), scopeHash: z.string() }).strict().optional(),
  verdict: planQaGateVerdictSchema.nullable(),
}).strict();
export type PlanQaVerdictState = z.infer<typeof planQaVerdictStateSchema>;
