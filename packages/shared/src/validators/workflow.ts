import { z } from "zod";
import { workflowConditionGroupSchema } from "./workflow-condition.js";

/**
 * [purpose] Step dispatch contract — 사전조건/사후조건/미정의동작 구조 레코드.
 * 정의 시점(owner/plan)에 작성되고 발주 시 이슈 지침·실행카드·QA 루브릭에 전달된다.
 * [care] 규칙 8 — 계약 항목은 사람/소유자 작성 지침·검증 기준일 뿐, 실행 통제 권위가 아니다.
 * 런타임 코드는 계약 텍스트를 파싱해 성패/재시도/완료를 판정해서는 안 된다.
 */
const workflowStepContractSectionSchema = z.array(
  z.string().trim().min(1).max(1000),
).max(20);

export const workflowStepContractSchema = z
  .object({
    preconditions: workflowStepContractSectionSchema.optional(),
    postconditions: workflowStepContractSectionSchema.optional(),
    undefinedBehaviors: workflowStepContractSectionSchema.optional(),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const hasContent = [contract.preconditions, contract.postconditions, contract.undefinedBehaviors]
      .some((section) => (section?.length ?? 0) > 0);
    if (!hasContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract"],
        message: "contract must declare at least one non-empty section (preconditions/postconditions/undefinedBehaviors)",
      });
    }
  });

export type WorkflowStepContract = z.infer<typeof workflowStepContractSchema>;

const nullableUuidSchema = z.string().uuid().nullable();
const nullableDateTimeStringSchema = z.string().datetime().nullable();
const metadataSchema = z.record(z.unknown()).default({});
const optionalUuidSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().uuid().optional(),
);
const stringArrayDefaultSchema = z.preprocess(
  (value) => value ?? [],
  z.array(z.string()).default([]),
);

export const workflowDefinitionStatusSchema = z.enum(["active", "paused", "archived"]);
export const workflowExecutionModeSchema = z.enum(["static_dag", "dynamic_owner_plan"]);

export const workflowStepDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  type: z.enum(["agent", "tool", "if", "complete"]).or(z.string()).optional(),
  conditionGroup: workflowConditionGroupSchema.optional(),
  completionReason: z.string().trim().min(1).max(500).optional(),
  qaType: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/iu).optional(),
  toolName: z.string().optional(),
  toolArgs: z.unknown().optional(),
  tools: z.array(z.string()).optional(),
  toolNames: z.array(z.string()).optional(),
  allowedSearchScopes: z.array(z.string()).optional(),
  searchScopes: z.array(z.string()).optional(),
  sessionMode: z.string().optional(),
  onFailure: z.string().optional(),
  escalateTo: z.string().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  triggerOn: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  dynamicChildren: z.union([z.boolean(), z.string()]).optional(),
  ownerPlanBootstrapOnly: z.union([z.boolean(), z.string()]).optional(),
  bootstrapOnly: z.union([z.boolean(), z.string()]).optional(),
  agentName: z.string().optional(),
  agentId: optionalUuidSchema,
  assigneeAgentId: optionalUuidSchema,
  // union accepts legacy string form ("true") on read; normalize coerces to boolean.
  graphWorkProductRequired: z.union([z.boolean(), z.string()]).optional(),
  graphWorkProductPattern: z.string().optional(),
  graphResourceRefs: z.array(z.string()).optional(),
  graphSecretRefs: z.array(z.string()).optional(),
  graphRetryDelaySeconds: z.number().int().nonnegative().optional(),
  graphRetryBackoff: z.enum(["fixed", "linear", "exponential"]).optional(),
  graphRetryJitter: z.boolean().optional(),
  contract: workflowStepContractSchema.optional(),
})
  .passthrough()
  .superRefine((step, ctx) => {
    const nodeType = typeof step.type === "string" ? step.type : undefined;
    const hasConditionGroup = step.conditionGroup !== undefined;
    const hasCompletionReason = step.completionReason !== undefined;
    if (step.contract !== undefined && (nodeType === "if" || nodeType === "complete")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract"], message: "contract is only allowed on executable steps, not if/complete control nodes" });
    }
    if (nodeType === "if") {
      if (!hasConditionGroup) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conditionGroup"], message: "IF step requires conditionGroup" });
      }
      if (hasCompletionReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completionReason"], message: "completionReason is only allowed on complete steps" });
      }
    } else if (nodeType === "complete") {
      if (hasConditionGroup) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conditionGroup"], message: "conditionGroup is not allowed on complete steps" });
      }
    } else {
      if (hasConditionGroup) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conditionGroup"], message: "conditionGroup is only allowed on if steps" });
      }
      if (hasCompletionReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completionReason"], message: "completionReason is only allowed on complete steps" });
      }
    }
  });

export const workflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: z.string().default("active"),
  steps: z.array(workflowStepDefinitionSchema).default([]),
  schedule: z.string().nullable(),
  timezone: z.string().nullable(),
  deadlineTime: z.string().nullable(),
  lastScheduledRunAt: nullableDateTimeStringSchema,
  lastScheduleError: z.string().nullable(),
  lastScheduleErrorAt: nullableDateTimeStringSchema,
  timeoutMinutes: z.number().int().positive().nullable(),
  maxDailyRuns: z.number().int().positive().nullable(),
  maxConcurrentRuns: z.number().int().positive().nullable(),
  triggerLabels: stringArrayDefaultSchema,
  labelIds: stringArrayDefaultSchema,
  projectId: nullableUuidSchema,
  goalId: nullableUuidSchema,
  createParentIssuePolicy: z.string().nullable(),
  executionMode: z.string().nullable(),
  dynamicPlanBootstrapOnly: z.boolean().default(false),
  source: z.string().nullable(),
  sourceKind: z.string().nullable(),
  legacyPluginEntityId: nullableUuidSchema,
  legacyMetadata: metadataSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const workflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  companyId: z.string().uuid(),
  missionId: nullableUuidSchema,
  status: z.string().default("pending"),
  originalStatus: z.string().nullable(),
  triggeredBy: z.string().min(1),
  triggerSource: z.string().nullable(),
  runDate: z.string().nullable(),
  runNumber: z.number().int().nullable(),
  runLabel: z.string().nullable(),
  parentIssueId: nullableUuidSchema,
  scheduledSlotId: nullableUuidSchema,
  legacyPluginRunEntityId: nullableUuidSchema,
  metadata: metadataSchema,
  startedAt: nullableDateTimeStringSchema,
  completedAt: nullableDateTimeStringSchema,
  createdAt: z.string().datetime(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowStepRunSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepId: z.string().min(1),
  issueId: nullableUuidSchema,
  status: z.string().default("pending"),
  originalStatus: z.string().nullable(),
  agentName: z.string().nullable(),
  retryCount: z.number().int().nonnegative().default(0),
  sessionId: z.string().nullable(),
  lastDispatchAttemptAt: nullableDateTimeStringSchema,
  lastDispatchAcceptedAt: nullableDateTimeStringSchema,
  lastDispatchErrorAt: nullableDateTimeStringSchema,
  lastDispatchErrorSummary: z.string().nullable(),
  lastDispatchRequestId: z.string().nullable(),
  legacyPluginStepEntityId: nullableUuidSchema,
  metadata: metadataSchema,
  startedAt: nullableDateTimeStringSchema,
  completedAt: nullableDateTimeStringSchema,
});

export type WorkflowStepRun = z.infer<typeof workflowStepRunSchema>;

export const workflowRunSlotSchema = z.object({
  id: z.string().uuid(),
  workflowDefinitionId: z.string().uuid(),
  companyId: z.string().uuid(),
  triggerSource: z.string().default("schedule"),
  scheduledAt: z.string().datetime(),
  runDate: z.string().nullable(),
  timezone: z.string().nullable(),
  claimedAt: z.string().datetime(),
  status: z.string().default("claimed"),
  metadata: metadataSchema,
});

export type WorkflowRunSlot = z.infer<typeof workflowRunSlotSchema>;


const nullableOptionalUuidSchema = z.string().uuid().nullable().optional();
const optionalStringArraySchema = z.preprocess(
  (value) => value ?? undefined,
  z.array(z.string()).optional(),
);

export const workflowRunInputDeriveFromSchema = z.object({
  input: z.string().min(1),
  extract: z.enum(["youtubeVideoId"]),
}).strict();

export const workflowRunInputSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_]{1,40}$/),
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  // [목적] 실행 입력의 서버 파생 선언. extract는 고정 명명 추출기 레지스트리만 허용한다 —
  // 정의에 임의 정규식을 저장하지 않는다(ReDoS·실행권위 방어). 소스 키 존재 검증은
  // 저장 시점 도메인 검증(engine validateRunInputDeclarations)이 담당한다.
  deriveFrom: workflowRunInputDeriveFromSchema.optional(),
}).strict();

export type WorkflowRunInput = z.infer<typeof workflowRunInputSchema>;

export const createWorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  status: workflowDefinitionStatusSchema.optional(),
  steps: z.array(workflowStepDefinitionSchema).default([]),
  schedule: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  deadlineTime: z.string().nullable().optional(),
  timeoutMinutes: z.number().int().positive().nullable().optional(),
  maxDailyRuns: z.number().int().positive().nullable().optional(),
  maxConcurrentRuns: z.number().int().positive().nullable().optional(),
  triggerLabels: optionalStringArraySchema,
  labelIds: optionalStringArraySchema,
  projectId: nullableOptionalUuidSchema,
  goalId: nullableOptionalUuidSchema,
  createParentIssuePolicy: z.string().nullable().optional(),
  executionMode: workflowExecutionModeSchema.nullable().optional(),
  dynamicPlanBootstrapOnly: z.boolean().optional(),
  runInputs: z.array(workflowRunInputSchema).max(5).optional(),
  source: z.string().nullable().optional(),
  sourceKind: z.string().nullable().optional(),
  legacyMetadata: metadataSchema.optional(),
}).strict();

export type CreateWorkflowDefinition = z.infer<typeof createWorkflowDefinitionSchema>;

export const updateWorkflowDefinitionSchema = createWorkflowDefinitionSchema.partial().extend({
  legacyMetadata: metadataSchema.optional(),
}).strict();

export type UpdateWorkflowDefinition = z.infer<typeof updateWorkflowDefinitionSchema>;

export const workflowToolGrantSchema = z.object({
  agentId: z.string().uuid(),
  toolName: z.string().min(1),
}).strict();

export type WorkflowToolGrantInput = z.infer<typeof workflowToolGrantSchema>;

export const triggerWorkflowRunSchema = z.object({
  missionId: z.string().uuid().optional(),
  triggeredBy: z.string().min(1).optional(),
  triggerSource: z.string().nullable().optional(),
  runDate: z.string().nullable().optional(),
  runNumber: z.number().int().positive().nullable().optional(),
  runLabel: z.string().nullable().optional(),
  parentIssueId: nullableOptionalUuidSchema,
  metadata: metadataSchema.optional(),
}).strict();

export type TriggerWorkflowRun = z.infer<typeof triggerWorkflowRunSchema>;

export const resumeWorkflowRunSchema = z.object({}).strict();
export type ResumeWorkflowRun = z.infer<typeof resumeWorkflowRunSchema>;

export const cancelWorkflowRunSchema = z.object({
  reason: z.string().optional(),
}).strict();
export type CancelWorkflowRun = z.infer<typeof cancelWorkflowRunSchema>;

export const manualCompleteWorkflowIssueSchema = z.object({}).strict();
export type ManualCompleteWorkflowIssue = z.infer<typeof manualCompleteWorkflowIssueSchema>;
