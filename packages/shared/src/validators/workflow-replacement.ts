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
  idempotencyKey: z.string().min(1).max(200),
  // externalEffects 는 재실행 전 외부 효과 정산 주체의 기계 생성 증명값이다.
  // 보드 제안은 operator_reconciled, 오너 자가 승인은 owner_agent_reconciled 만 허용한다.
  externalEffects: z.enum(["operator_reconciled", "owner_agent_reconciled"]),
  // 오너 에이전트 자가 승인 마커 — 사람 승인(decidedByUserId) 없이 approved 로 기록된 행만
  // true 다. admission 은 이 마커와 payload.requesterAgentId(미션 오너) 일치로만 수용한다.
  ownerAgentSelfApproval: z.boolean().optional(),
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
// 오너 에이전트 자가 교체 요청 입력 — 보드 propose 와 달리 externalEffects 증명(오너 정산)과
// reason(감사용)만 다르고 나머지 계약(스코프·멱등 키·메타데이터)은 동일하다.
export const ownerSelfReplacementSchema = z.object({
  sourceRunId: z.string().uuid(), decisionEventId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(200),
  metadata: z.record(z.unknown()).default({}),
  reason: z.string().max(4000).optional(),
}).strict();
export type OwnerSelfReplacement = z.input<typeof ownerSelfReplacementSchema>;
