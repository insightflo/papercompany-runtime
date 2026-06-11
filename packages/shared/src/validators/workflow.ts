import { z } from "zod";

const nullableUuidSchema = z.string().uuid().nullable();
const nullableDateTimeStringSchema = z.string().datetime().nullable();
const metadataSchema = z.record(z.unknown()).default({});
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
  type: z.string().optional(),
  toolName: z.string().optional(),
  toolArgs: z.unknown().optional(),
  tools: z.array(z.string()).optional(),
  toolNames: z.array(z.string()).optional(),
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
  agentId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
}).passthrough();

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
}).strict();

export type CreateWorkflowDefinition = z.infer<typeof createWorkflowDefinitionSchema>;

export const updateWorkflowDefinitionSchema = createWorkflowDefinitionSchema.partial().extend({
  legacyMetadata: metadataSchema.optional(),
}).strict();

export type UpdateWorkflowDefinition = z.infer<typeof updateWorkflowDefinitionSchema>;

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
