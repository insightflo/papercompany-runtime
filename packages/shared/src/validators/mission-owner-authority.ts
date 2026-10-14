// [mission owner execution authority v1] 외부 실행 요청/결과조회 입력 계약.
//   권위는 이 스키마만으로 생기지 않는다 — 서버 adapter 가 회사/미션/현재 오너/
//   최신 구조 intent/native 권한을 별도 검증한다(계획 2026-10-10 공통 계약).
import { z } from "zod";

const uuid = z.string().uuid();
const exactFailure = z.object({
  workflowRunId: uuid,
  stepRunId: uuid,
  expectedAuthorityVersion: z.number().int().nonnegative(),
  expectedExecutionGeneration: z.number().int().nonnegative(),
  failedDispatchRequestId: z.string().min(1).nullable(),
}).strict();
const stepTarget = z.discriminatedUnion("kind", [
  exactFailure.extend({ kind: z.literal("tool_step") }),
  exactFailure.extend({ kind: z.literal("issue_step"), issueId: uuid }),
]);
const planInput = z.object({
  planningIssueId: uuid,
  expectedDecisionHash: z.string().min(1).nullable(),
  // Native plan validation checks units/dependencies/inputs/outputs.
  // Preserve the raw object; do not strip fields or synthesize revisionDelta.
  decision: z.record(z.unknown()),
}).strict();
const action = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("retry_step"), target: stepTarget }).strict(),
  z.object({ operation: z.literal("promote_unblock_product"),
    target: exactFailure.extend({ kind: z.literal("tool_step") }),
    productId: uuid, producerStepId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("resume_run"), target: stepTarget,
    terminalDecisionId: uuid,
    previewPolicy: z.enum(["native_failed_anchor_v1", "signed_unexecuted_tail"]) }).strict(),
  z.object({ operation: z.literal("revise_plan"), plan: planInput }).strict(),
  z.object({ operation: z.literal("recollect"), collectorTarget: stepTarget,
    sourceRefs: z.array(z.string().min(1)).min(1),
    mode: z.enum(["same_configuration", "changed_collection"]),
    plan: planInput.optional() }).strict(),
  z.object({ operation: z.literal("delegate_fix"), producerTarget: stepTarget,
    qaVerdictEventId: uuid, findingIds: z.array(z.string().min(1)).min(1),
    collection: z.object({ sourceRefs: z.array(z.string().min(1)).min(1),
      plan: planInput.optional() }).strict().optional(), plan: planInput.optional() }).strict(),
  z.object({ operation: z.literal("reassign"), target: stepTarget,
    targetAgentId: uuid, plan: planInput.optional() }).strict(),
]);

export const missionOwnerExecuteSchema = z.object({
  schemaVersion: z.literal(1), missionId: uuid, ownerActionIssueId: uuid,
  actionRequestId: uuid, expectedIntentEventId: uuid.nullable(),
  ownerDecisionEventId: uuid.nullable(), action,
}).strict();
export const missionOwnerGetResultSchema = z.object({
  schemaVersion: z.literal(1), missionId: uuid, actionId: uuid,
}).strict();
export type MissionOwnerExecuteRequest = z.infer<typeof missionOwnerExecuteSchema>;
export type MissionOwnerGetResultRequest = z.infer<typeof missionOwnerGetResultSchema>;
export type MissionOwnerAction = MissionOwnerExecuteRequest["action"];
