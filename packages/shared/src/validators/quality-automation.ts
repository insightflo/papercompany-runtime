import { z } from "zod";
import { refineQualityEffect } from "./quality-action-decision.js";

/**
 * Quality 자동화의 공용 계약·정책 검증기(설계 §3.2).
 * strict Zod schema만 내보내고 타입은 z.infer로 만든다. 누락값·무한값에 기본값을 넣지 않는다.
 */

export const QUALITY_NATIVE_OWNERSHIP_VALUES = ["native-active-plugin-disabled"] as const;
export type QualityNativeOwnership = (typeof QUALITY_NATIVE_OWNERSHIP_VALUES)[number];

export const uuidSchema = z.string().uuid().toLowerCase();
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256");
const nonNegativeInteger = z.number().int().safe().min(0);
const isoDateTime = z.string().datetime();

/** 누락·무한·음수·소수 횟수를 기본값 없이 거부한다. allowZero는 재시도 허용 횟수에만 쓴다. */
export function finiteCount(value: unknown, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)) throw new Error("quality_invalid_limit");
  return value;
}

function finiteCountField(allowZero: boolean) {
  return z.number().superRefine((value, ctx) => {
    try {
      finiteCount(value, allowZero);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_invalid_limit" });
    }
  });
}

function uniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueIdArray(minItems: number) {
  return z.array(uuidSchema).min(minItems).refine(uniqueValues, "quality_duplicate_entry");
}

export const artifactRefSchema = z.object({
  attachmentId: uuidSchema,
  sha256: sha256HexSchema,
}).strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
const uniqueArtifactRefs = z.array(artifactRefSchema).min(1).refine(
  (refs) => new Set(refs.map((ref) => ref.attachmentId)).size === refs.length, "quality_duplicate_entry",
);

export const qualityKeySchema = z.object({
  companyId: uuidSchema,
  actionId: uuidSchema,
}).strict();
export type QualityKey = z.infer<typeof qualityKeySchema>;

export const qualityAgentActorSchema = z.object({
  agentId: uuidSchema,
  companyId: uuidSchema,
  heartbeatRunId: uuidSchema,
  executionEpoch: nonNegativeInteger,
}).strict();
export type QualityAgentActor = z.infer<typeof qualityAgentActorSchema>;

export const qualityHumanActorSchema = z.object({
  userId: z.string().min(1).max(200),
  source: z.enum(["session", "board_key", "local_implicit"]),
  keyId: uuidSchema.nullable(),
}).strict();
export type QualityHumanActor = z.infer<typeof qualityHumanActorSchema>;

const missionRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mission"), id: uuidSchema }).strict(),
  z.object({ kind: z.literal("not_applicable"), reason: z.literal("no_source_mission") }).strict(),
]);

const workflowRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow_step"),
    runId: uuidSchema,
    stepRunId: uuidSchema,
    generation: nonNegativeInteger,
    dispatchAuthorityVersion: nonNegativeInteger,
  }).strict(),
  z.object({ kind: z.literal("not_applicable"), reason: z.literal("not_a_workflow_source") }).strict(),
]);

export const sourceAttemptSchema = z.object({
  companyId: uuidSchema,
  issueId: uuidSchema,
  heartbeatRunId: uuidSchema,
  executionEpoch: nonNegativeInteger,
  inputHash: sha256HexSchema,
  mission: missionRefSchema,
  workflow: workflowRefSchema,
}).strict();
export type SourceAttempt = z.infer<typeof sourceAttemptSchema>;

export const qualityTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("current_output"),
    source: sourceAttemptSchema,
  }).strict(),
  z.object({
    kind: z.literal("qa_addendum"),
    companyId: uuidSchema,
    templateId: uuidSchema,
    baseHash: sha256HexSchema,
    requirementVersionId: z.string().min(1).max(200),
    inputHash: sha256HexSchema,
    // 후보 생성 이전 명시적 phase에서만 null. 선택·평가·적용 효과는 단계별 검증으로 실제 ID를 요구한다.
    candidateVersionId: uuidSchema.nullable(),
    evaluationId: uuidSchema.nullable(),
    intentKey: z.string().min(1).max(200),
    execution: z.object({
      kind: z.literal("not_yet_accepted"),
      reason: z.literal("new_improvement_execution"),
    }).strict(),
  }).strict(),
]);
export type QualityTarget = z.infer<typeof qualityTargetSchema>;

const targetField = () => z.lazy(() => qualityTargetSchema);

export const qualityEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repair_supported_output"), target: targetField() }).strict(),
  z.object({ kind: z.literal("evaluate_candidate"), target: targetField() }).strict(),
  z.object({
    kind: z.literal("select_candidate"),
    candidateVersionId: uuidSchema,
    target: targetField(),
  }).strict(),
  z.object({
    kind: z.literal("reevaluate_requirements"),
    requirementVersionId: z.string().min(1).max(200),
    target: targetField(),
  }).strict(),
  z.object({
    kind: z.literal("hold"),
    remindAt: isoDateTime.nullable(),
    target: targetField(),
  }).strict(),
  z.object({ kind: z.literal("reject"), target: targetField() }).strict(),
]).superRefine(refineQualityEffect);
export type QualityEffect = z.infer<typeof qualityEffectSchema>;

export const retryEnvelopeSchema = z.object({
  intentKey: z.string().min(1).max(200),
  effectHash: sha256HexSchema,
  targetHash: sha256HexSchema,
  maxExecutorAttempts: finiteCountField(false),
  deadlineAt: isoDateTime,
  groupId: uuidSchema,
  policyVersionId: uuidSchema,
  maxCumulativeCostCents: finiteCountField(false),
}).strict();
export type RetryEnvelope = z.infer<typeof retryEnvelopeSchema>;

export const nativeBindingSchema = z.object({
  companyId: uuidSchema,
  actionId: uuidSchema,
  missionId: uuidSchema,
  workflowRunId: uuidSchema,
  stepRunId: uuidSchema,
  issueId: uuidSchema,
}).strict();
export type NativeBinding = z.infer<typeof nativeBindingSchema>;

export const applicabilitySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("always") }).strict(),
  z.object({
    op: z.literal("selected_templates_all"),
    templateIds: z.array(uuidSchema).min(1).refine(uniqueValues, "quality_duplicate_entry"),
  }).strict(),
]);
export type Applicability = z.infer<typeof applicabilitySchema>;

export const addendumCheckSchema = z.object({
  checkId: z.string().min(1).max(200),
  requirementRefs: uniqueArtifactRefs,
  applicability: applicabilitySchema,
  expectedEvidenceKinds: z.array(z.string().min(1).max(120)).min(1).refine(uniqueValues, "quality_duplicate_entry"),
  instructions: z.string().min(1).max(4_000),
}).strict();
export type AddendumCheck = z.infer<typeof addendumCheckSchema>;

export const qualityPolicyTargetSchema = z.object({
  companyId: uuidSchema,
  templateId: uuidSchema,
  baseHash: sha256HexSchema,
  required: z.array(addendumCheckSchema).min(1).refine(
    (checks) => uniqueValues(checks.map((check) => check.checkId)), "quality_duplicate_entry",
  ),
}).strict();
export type QualityPolicyTarget = z.infer<typeof qualityPolicyTargetSchema>;

/**
 * 회사 정책 계약. 모든 수치·대상·권한은 명시적이어야 하며 누락·무한값은 거부된다.
 * allowZero=true는 maxEvidenceResubmissions(재시도 허용)뿐이다.
 */
export const qualityPolicySchema = z.object({
  targets: z.array(qualityPolicyTargetSchema).min(1, "quality_empty_targets"),
  authorAgentIds: uniqueIdArray(1),
  verifierAgentIds: uniqueIdArray(1),
  allowedToolIds: uniqueIdArray(0),
  reviewerUserIds: z.array(z.string().min(1).max(200)).min(1).refine(uniqueValues, "quality_duplicate_entry"),
  rollbackUserIds: z.array(z.string().min(1).max(200)).min(1).refine(uniqueValues, "quality_duplicate_entry"),
  requirementSourceRefs: uniqueArtifactRefs,
  caseOracleRefs: uniqueArtifactRefs,
  nativeOwnership: z.enum(QUALITY_NATIVE_OWNERSHIP_VALUES),
  maxActions: finiteCountField(false),
  maxCandidatesPerAction: finiteCountField(false),
  maxEvaluationsPerCandidate: finiteCountField(false),
  maxOuterCycles: finiteCountField(false),
  maxEvidenceResubmissions: finiteCountField(true),
  maxExecutionAttempts: finiteCountField(false),
  maxCostCentsPerGroup: finiteCountField(false),
  maxCostCentsPerPeriod: finiteCountField(false),
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  maxElapsedSeconds: finiteCountField(false),
  decisionTtlSeconds: finiteCountField(false),
  observationSeconds: finiteCountField(false),
  reconcileBatchSize: finiteCountField(false),
}).strict().superRefine((policy, ctx) => {
  const companyIds = new Set(policy.targets.map((target) => target.companyId));
  if (companyIds.size !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_policy_company_mismatch" });
  }
  const targetKeys = new Set(policy.targets.map((t) => `${t.templateId}:${t.baseHash}`));
  if (targetKeys.size !== policy.targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_policy_duplicate_target" });
  }
  const authors = new Set(policy.authorAgentIds);
  if (policy.verifierAgentIds.some((id) => authors.has(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_policy_role_overlap" });
  }
  if (Date.parse(policy.periodEnd) <= Date.parse(policy.periodStart)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality_policy_invalid_period" });
  }
});
export type QualityPolicy = z.infer<typeof qualityPolicySchema>;
