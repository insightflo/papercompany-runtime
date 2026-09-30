import { z } from "zod";
import { workflowRunInputsSchema } from "./workflow-run-inputs.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const replacementIntentSchema = z.object({
  schemaVersion: z.literal(1), sourceRunId: z.string().uuid(), expectedSourceAuthorityVersion: z.number().int().nonnegative(),
  decisionEventId: z.string().uuid(), approvalId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200),
}).strict();
export type ReplacementIntent = z.infer<typeof replacementIntentSchema>;
export const replacementApprovalPayloadSchema = z.object({
  schemaVersion: z.literal(1), companyId: z.string().uuid(), missionId: z.string().uuid(), workflowId: z.string().uuid(),
  sourceRunId: z.string().uuid(), sourceAuthorityVersion: z.number().int().nonnegative(), terminalDecisionId: z.string().uuid(),
  decisionEventId: z.string().uuid(), requesterAgentId: z.string().uuid(), targetRunId: z.string().uuid(),
  requestGeneration: z.number().int().nonnegative(), stepRunId: z.string().uuid(),
  definitionHash: hash, inputHash: hash, metadata: z.record(z.unknown()),
  inputContract: workflowRunInputsSchema.optional(),
  idempotencyKey: z.string().min(1).max(200), externalEffects: z.literal("operator_reconciled"),
}).strict();
export const replacementDecisionSchema = z.object({ decisionNote: z.string().max(4000).optional() }).strict();
export const resubmitReplacementSchema = z.object({
  decisionEventId: z.string().uuid().optional(), idempotencyKey: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(), externalEffects: z.literal("operator_reconciled").optional(),
}).strict();
export type ReplacementApprovalPayload = z.infer<typeof replacementApprovalPayloadSchema>;
export type ProposeReplacement = z.input<typeof proposeReplacementSchema>;
export const proposeReplacementSchema = z.object({
  sourceRunId: z.string().uuid(), decisionEventId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200),
  metadata: z.record(z.unknown()).default({}), externalEffects: z.literal("operator_reconciled"),
}).strict();
