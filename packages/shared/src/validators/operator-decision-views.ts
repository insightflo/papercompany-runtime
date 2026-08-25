import { z } from "zod";
import {
  operatorDecisionDefinitionSchema,
  operatorDecisionResolveInputSchema,
  operatorDecisionSourceContextSchema,
} from "./operator-decision.js";

const priorityEnum = z.enum(["critical", "high", "medium", "low"]);
const statusEnum = z.enum(["pending", "resolved", "cancelled"]);
const interactionTypeEnum = z.enum(["single_select", "multi_select", "action"]);
const continuationModeEnum = z.enum(["none", "issue_current_assignee"]);
const outcomeEnum = z.enum(["submit", "approve", "reject", "hold"]);
const continuationStateEnum = z.enum(["pending", "leased", "accepted", "blocked", "exhausted"]);
const effectiveStatusEnum = z.enum([
  "pending", "dispatching", "blocked", "exhausted", "queued", "deferred",
  "running", "coalesced", "completed", "skipped", "failed", "cancelled",
  "timed_out", "agent_unrunnable", "assignee_changed", "issue_terminal",
]);

export const operatorDecisionResultSchema = z.object({
  actionId: z.string(),
  outcome: outcomeEnum,
  selectedOptionIds: z.array(z.string()),
  comment: z.string().nullable(),
}).strict();

export const operatorDecisionContinuationViewSchema = z.object({
  id: z.string(),
  state: continuationStateEnum,
  generation: z.number().int().min(1).max(3),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.literal(3),
  manualRetryCount: z.number().int().min(0).max(2),
  maxManualRetries: z.literal(2),
  nextAttemptAt: z.string(),
  leaseExpiresAt: z.string().nullable(),
  targetAgentId: z.string().nullable(),
  wakeupRequestId: z.string().nullable(),
  effectiveStatus: effectiveStatusEnum,
  errorCode: z.string().nullable(),
}).strict();

const requestedBySchema = z.object({
  type: z.enum(["agent", "user"]),
  id: z.string(),
}).strict().nullable();

export const operatorDecisionViewSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  schemaVersion: z.literal(1),
  requestKey: z.string(),
  status: statusEnum,
  priority: priorityEnum,
  interactionType: interactionTypeEnum,
  title: z.string(),
  description: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  sourceContext: operatorDecisionSourceContextSchema,
  definition: operatorDecisionDefinitionSchema,
  result: operatorDecisionResultSchema.nullable(),
  issueId: z.string().nullable(),
  /** Operator-facing labels for the linked issue/mission — lets the pending card
   *  header say WHICH mission/issue the decision belongs to without extra lookups. */
  issueIdentifier: z.string().nullable(),
  issueTitle: z.string().nullable(),
  missionTitle: z.string().nullable(),
  continuationMode: continuationModeEnum,
  requestedBy: requestedBySchema,
  resolvedByUserId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  continuation: operatorDecisionContinuationViewSchema.nullable(),
}).strict();

export const operatorDecisionCreateResponseSchema = z.object({
  data: operatorDecisionViewSchema,
  replayed: z.boolean(),
}).strict();

export const operatorDecisionDetailResponseSchema = z.object({
  data: operatorDecisionViewSchema,
}).strict();

export const operatorDecisionListResponseSchema = z.object({
  data: z.array(operatorDecisionViewSchema),
  page: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();

export const operatorDecisionResolutionResponseSchema = z.object({
  data: z.object({
    decision: operatorDecisionViewSchema,
    applied: z.boolean(),
    continuation: operatorDecisionContinuationViewSchema.nullable(),
  }).strict(),
}).strict();

export type OperatorDecisionResult = z.infer<typeof operatorDecisionResultSchema>;
export type OperatorDecisionContinuationView = z.infer<typeof operatorDecisionContinuationViewSchema>;
export type OperatorDecisionView = z.infer<typeof operatorDecisionViewSchema>;

export {
  operatorDecisionResolveInputSchema,
  operatorDecisionDefinitionSchema,
};
