// [목적] 미션 오너의 구조적 실행 요청(mission_owner_execute tool)을 기존 native 경로에 연결한다.
//   intent 는 workflow_transition_events 의 machine contract(owner_execute_intent_v1/applied_v1)로 기록하고(상태
//   계약은 mission-owner-execution-state.ts), 실제 reset·전달은 retryIssueLessToolWorkflowStep(tool_step, strict)와
//   dispatchSourceIssueNativeResume(issue_step, strict accept), [Stage 5/6/7] revise_plan·recollect·delegate_fix 은
//   각 전용 모듈이, generic wake/heartbeat fallback 은 없다. body actor 는 무시되고 인증 서버 입력만 쓴다.
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { MissionOwnerAction, MissionOwnerExecuteRequest, MissionOwnerGetResultRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import type { OwnerActionResult as OwnerActionResultType } from "./mission-owner-execution-state.js";
import { intentIdempotencyKey, intentKeyWhere, latestIntentEventId, loadAppliedPayload, projectOwnerActionResult, recordAppliedEvent, stable } from "./mission-owner-execution-state.js";
import { retryIssueLessToolWorkflowStep, syncWorkflowRunState } from "../workflow/dag-engine.js";
import { latestTerminalDecision } from "../workflow/run-recovery-authority.js";
import { deliverAcceptedToolRecovery } from "../workflow/tool-recovery-delivery.js";
import { dispatchSourceIssueNativeResume, type AutomaticSourceResumeInput } from "../workflow/source-issue-native-resume.js";
import { executeOwnerRunResume, finalizeOwnerResumeProjection, previewOwnerNativeRunResume } from "./mission-owner-resume-run.js";
import { executeOwnerPlanAction, projectOwnerPlanActionResult } from "./mission-owner-plan-action.js";
import { executeOwnerRecollect, preflightOwnerRecollect, projectOwnerRecollectResult } from "./mission-owner-recollect.js";
import { executeOwnerDelegateFix, preflightOwnerDelegateFix, projectOwnerDelegateFixResult } from "./mission-owner-delegate-fix.js";
import { executeOwnerReassign, preflightOwnerReassign, projectOwnerReassignResult } from "./mission-owner-reassign.js";
import { executeOwnerUnblockPromotion } from "./mission-owner-promote-unblock.js";

export type OwnerExecutionContext = { db: Db; companyId: string; agentId: string; heartbeatRunId: string };
export type { OwnerActionResult, OwnerExecutionAdmission } from "./mission-owner-execution-state.js";
export { withCurrentOwnerToolAttempt } from "./mission-owner-execution-state.js";
export type OwnerStepTarget = Extract<MissionOwnerAction, { operation: "retry_step" }>["target"];
type OwnerActionResult = OwnerActionResultType;
export class OwnerActionRefusalError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly reasonCode: string) { super(reasonCode); }
}
const SOURCE = "mission_owner_execute";
const REFERENCE_PREFIX = "mission-owner-execute:";
const LIVE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution", "coalesced"] as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numOf = (value: unknown): number => typeof value === "number" && Number.isInteger(value) ? value : 0;
const refusal = (status: 403 | 404 | 409 | 422, reasonCode: string): never => { throw new OwnerActionRefusalError(status, reasonCode); };
async function authenticate(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest): Promise<void> {
  const [heartbeat] = await context.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.agentId, context.agentId), eq(heartbeatRuns.issueId, request.ownerActionIssueId))).limit(1);
  if (!heartbeat) refusal(403, "heartbeat_mismatch");
  const [issue] = await context.db.select({ missionId: issues.missionId }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId), eq(issues.companyId, context.companyId))).limit(1);
  if (!issue || issue.missionId !== request.missionId) refusal(404, "owner_action_issue_not_found");
  const [mission] = await context.db.select({ status: missions.status, ownerAgentId: missions.ownerAgentId }).from(missions)
    .where(and(eq(missions.id, request.missionId), eq(missions.companyId, context.companyId))).limit(1);
  if (!mission) refusal(404, "mission_not_found");
  if (mission.status !== "active") refusal(403, "mission_not_active");
  if (mission.ownerAgentId !== context.agentId) refusal(403, "not_mission_owner"); }
export async function recoverDeliveryIfNeeded(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>): Promise<void> {
  const applied = await loadAppliedPayload(context.db, context.companyId, actionId);
  const stepRunId = typeof applied?.stepRunId === "string" ? applied.stepRunId : null;
  if (!stepRunId) return;
  const action = request.action; // [Stage 6] recollect same_configuration 의 issue_step 재전달은 stage 3 native wake 경로가 소유한다.
  const stepTarget = action.operation === "recollect" ? action.collectorTarget : action.operation === "retry_step" || action.operation === "resume_run" || action.operation === "reassign" ? action.target : null;
  if ((action.operation === "retry_step" || action.operation === "resume_run" || action.operation === "reassign"
    || (action.operation === "recollect" && action.mode === "same_configuration")) && stepTarget?.kind === "issue_step") {
    const [step] = await context.db.select({ status: workflowStepRuns.status }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRunId)).limit(1);
    if (!step || !["pending", "running"].includes(step.status)) return;
    // Applied-but-undelivered issue steps recover DELIVERY ONLY via the same native wake path (no second reset/cap).
    await dispatchSourceIssueNativeResume(context.db, {
      companyId: context.companyId, issueId: stepTarget.issueId, agentId: context.agentId, allowBlockedIssue: true,
      ownerExecution: { actionId, missionId: request.missionId, workflowRunId: stepTarget.workflowRunId, stepRunId,
        expectedAuthorityVersion: numOf(applied?.authorityVersion), expectedExecutionGeneration: numOf(applied?.executionGeneration),
        failedDispatchRequestId: typeof applied?.dispatchRequestId === "string" ? applied.dispatchRequestId : null,
        validateIntent } } satisfies AutomaticSourceResumeInput).catch(() => undefined);
    return;
  }
  const [step] = await context.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).limit(1);
  // Applied-but-undelivered recovers DELIVERY ONLY — never a second reset or cap consumption.
  if (step && step.status === "pending" && !step.lastDispatchRequestId) {
    await deliverAcceptedToolRecovery(context.db, step.id, (db, runId) => syncWorkflowRunState(db, runId, "workflow_retry")).catch(() => undefined); }
}
const evidenceItem = (kind: "authority" | "dispatch" | "heartbeat", recordId: string | null,
  workflowRunId: string | null, stepRunId: string | null, executionGeneration: number | null, requestId: string | null) =>
  ({ kind, recordId: recordId ?? "", workflowRunId, stepRunId, executionGeneration, requestId });
async function diagnoseRefusal(context: OwnerExecutionContext, target: {
  stepRunId: string; expectedAuthorityVersion: number; expectedExecutionGeneration: number;
}): Promise<string> {  const [row] = await context.db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, target.stepRunId), eq(workflowRuns.companyId, context.companyId))).limit(1);
  if (!row) return "target_not_found";
  const [mission] = await context.db.select({ status: missions.status }).from(missions).where(and(eq(missions.id, row.run.missionId ?? ""), eq(missions.companyId, context.companyId))).limit(1);
  if (!mission || mission.status !== "active") return "mission_not_active";
  if (row.run.dispatchAuthorityVersion !== target.expectedAuthorityVersion) return "stale_authority_version";
  const decision = await latestTerminalDecision(context.db, row.run.id, context.companyId);
  if (!decision || decision.decidedAuthorityVersion !== target.expectedAuthorityVersion || decision.decision !== "failed") {
    return "missing_failed_decision";
  }
  if (row.stepRun.status !== "failed") return "step_not_failed";
  if (row.stepRun.executionGeneration !== target.expectedExecutionGeneration) return "stale_generation";
  if (record(row.stepRun.metadata).workflowRetryExhaustion) return "retry_exhausted";
  return "recovery_rejected";
}
/** [issue_step 투영] 복구된 현재 시도(영수증 version/generation 일치)만 읽는다. wake 미전달은 delivery_pending, 실제 worker 진행은 executing, 완료는 resolved 로 구분한다. */
export async function projectIssueActionResult(db: Db, companyId: string, missionId: string, actionId: string,
  issueId: string, operation: MissionOwnerAction["operation"] = "retry_step"): Promise<OwnerActionResult> {
  const base = { schemaVersion: 1 as const, actionId, operation, requiredAction: null };
  const applied = await loadAppliedPayload(db, companyId, actionId);
  if (!applied) return { ...base, state: "blocked", reasonCode: "action_not_applied",
    evidence: [evidenceItem("heartbeat", actionId, null, null, null, null)] };
  const workflowRunId = typeof applied.workflowRunId === "string" ? applied.workflowRunId : "";
  const stepRunId = typeof applied.stepRunId === "string" ? applied.stepRunId : "";
  const authorityId = typeof applied.authorityId === "string" ? applied.authorityId : null;
  const evidence = [evidenceItem("authority", authorityId, workflowRunId, stepRunId, null, null)];
  const [row] = await db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(eq(workflowStepRuns.id, stepRunId),
      eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId))).limit(1);
  if (!row) return { ...base, state: "needs_evidence", reasonCode: "attempt_record_missing", evidence,
    requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "attempt_record_missing" } };
  const receipt = record(row.stepRun.metadata).ownerToolRetry;
  if (numOf(applied.authorityVersion) !== row.run.dispatchAuthorityVersion || record(receipt).authorityId !== authorityId
    || numOf(applied.executionGeneration) !== row.stepRun.executionGeneration)
    return { ...base, state: "superseded", reasonCode: "attempt_superseded", evidence };
  evidence.push(evidenceItem("dispatch", row.stepRun.lastDispatchRequestId, workflowRunId,
    stepRunId, row.stepRun.executionGeneration, row.stepRun.lastDispatchRequestId));
  if (row.stepRun.status === "completed") return { ...base, state: "resolved", reasonCode: null, evidence };
  if (row.stepRun.status === "running") {
    const [liveWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.issueId, issueId), inArray(agentWakeupRequests.status, [...LIVE_WAKEUP_STATUSES]))).limit(1);
    const [liveHeartbeat] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
      inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);    if (!liveWake && !liveHeartbeat) return { ...base, state: "delivery_pending", reasonCode: null, evidence };
    return { ...base, state: "executing", reasonCode: null, evidence };
  }
  if (row.stepRun.status === "pending") return { ...base, state: "delivery_pending", reasonCode: null, evidence };
  if (row.stepRun.status === "failed") return { ...base, state: "blocked", reasonCode: "step_execution_failed", evidence };
  return { ...base, state: "blocked", reasonCode: "attempt_inactive", evidence };
}
export async function executeMissionOwnerAction(context: OwnerExecutionContext,
  request: MissionOwnerExecuteRequest): Promise<OwnerActionResult> {
  const action = request.action;
  if (action.operation !== "retry_step" && action.operation !== "resume_run" && action.operation !== "revise_plan" && action.operation !== "recollect" && action.operation !== "delegate_fix" && action.operation !== "reassign" && action.operation !== "promote_unblock_product") throw new OwnerActionRefusalError(422, "operation_not_available");
  await authenticate(context, request);
  // [Stage 5] revise_plan 은 target 이 없다: intent 기록 전에 planning issue 실재를 확인한다(부작용 0).
  // recollect·delegate_fix·reassign preflight is read-only; promotion revalidates atomically with strict retry.
  if (action.operation === "revise_plan") {
    const [planning] = await context.db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, action.plan.planningIssueId),
      eq(issues.companyId, context.companyId), eq(issues.missionId, request.missionId), eq(issues.originKind, "mission_main_executor_plan"))).limit(1);
    if (!planning) refusal(404, "planning_issue_not_found");
  }
  if (action.operation === "reassign") await preflightOwnerReassign(context, request);
  const target = action.operation === "revise_plan" ? null
    : action.operation === "recollect" ? action.collectorTarget
    : action.operation === "delegate_fix" ? action.producerTarget : action.target;
  if (target !== null && target.kind !== "tool_step" && target.kind !== "issue_step") throw new OwnerActionRefusalError(422, "target_kind_not_supported");
  const [stepRun] = target ? await context.db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, target.stepRunId),
    eq(workflowStepRuns.workflowRunId, target.workflowRunId))).limit(1) : [];
  const [run] = stepRun && target ? await context.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, target.workflowRunId),
    eq(workflowRuns.companyId, context.companyId))).limit(1) : [];
  if (target && (!stepRun || !run || run.missionId !== request.missionId
    || (target.kind === "issue_step" && stepRun.issueId !== target.issueId))) refusal(404, "target_not_found");
  if (action.operation === "recollect") await preflightOwnerRecollect(context, request);
  if (action.operation === "delegate_fix") await preflightOwnerDelegateFix(context, request);
  const idempotencyKey = intentIdempotencyKey(context.companyId, request.missionId, request.ownerActionIssueId, request.actionRequestId);
  const fingerprint = createHash("sha256").update(stable(request)).digest("hex").slice(0, 24);
  let actionId: string | null = null;
  let replay = false;
  await context.db.transaction(async (tx) => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId), eq(issues.companyId, context.companyId))).for("update");
    const [existing] = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(intentKeyWhere(context.companyId, idempotencyKey)).limit(1);
    if (existing) {
      if (record(existing.payload).bodyFingerprint !== fingerprint) refusal(409, "action_request_conflict");
      actionId = existing.id; replay = true; return;
    }
    if (request.expectedIntentEventId != null && await latestIntentEventId(tx as unknown as Db,
      context.companyId, request.ownerActionIssueId) !== request.expectedIntentEventId) refusal(409, "stale_intent");
    const inserted = await tx.insert(workflowTransitionEvents).values({ companyId: context.companyId,
      missionId: request.missionId, issueId: request.ownerActionIssueId, heartbeatRunId: context.heartbeatRunId,
      eventType: "owner_execute_intent_v1", layer: "mission_owner_authority", reason: SOURCE, reasonCode: SOURCE, idempotencyKey,
      payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: request.missionId,
        ownerActionIssueId: request.ownerActionIssueId, actionRequestId: request.actionRequestId,
        heartbeatRunId: context.heartbeatRunId, agentId: context.agentId, action: request.action, bodyFingerprint: fingerprint } })
      .onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
    if (inserted[0]) { actionId = inserted[0].id; return; }
    // Same key inserted concurrently — resolve the authoritative row under the same lock.
    const [raced] = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(intentKeyWhere(context.companyId, idempotencyKey)).limit(1);    if (!raced || record(raced.payload).bodyFingerprint !== fingerprint) refusal(409, "action_request_conflict");
    actionId = raced.id; replay = true;
  });
  const resolvedActionId = actionId!;
  const validateIntent = async (tx: Db): Promise<boolean> => {
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId }).from(missions).where(and(eq(missions.id, request.missionId), eq(missions.companyId, context.companyId))).limit(1);
    if (!mission || mission.status !== "active" || mission.ownerAgentId !== context.agentId) return false;
    return await latestIntentEventId(tx, context.companyId, request.ownerActionIssueId) === resolvedActionId;
  };
  const project = () => action.operation === "reassign"
    ? projectOwnerReassignResult(context.db, context.companyId, request.missionId, resolvedActionId)
    : action.operation === "recollect" || action.operation === "delegate_fix"
    ? (action.operation === "recollect" ? projectOwnerRecollectResult : projectOwnerDelegateFixResult)(context.db, context.companyId, request.missionId, resolvedActionId)
    : target?.kind === "issue_step"
      ? projectIssueActionResult(context.db, context.companyId, request.missionId, resolvedActionId, target.issueId, action.operation)
      : action.operation === "revise_plan"
        ? projectOwnerPlanActionResult(context.db, context.companyId, request.missionId, resolvedActionId)
        : projectOwnerActionResult(context.db, context.companyId, request.missionId, resolvedActionId, action.operation);
  if (replay) {
    await recoverDeliveryIfNeeded(context, request, resolvedActionId, validateIntent);
    const projected = await project();
    if (projected.reasonCode === "action_not_applied") {
      if (action.operation === "promote_unblock_product") return executeOwnerUnblockPromotion(context, request, resolvedActionId, validateIntent);
      if (action.operation === "resume_run") return { ...projected, reasonCode: (await previewOwnerNativeRunResume(context, request)).reasonCode };
      if (action.operation === "revise_plan" || action.operation === "reassign" || (action.operation === "recollect" && action.mode === "changed_collection")) return projected; // 계획/재배정 투영은 intent+refs 기반이라 이 상태가 없다
      return { ...projected, reasonCode: await diagnoseRefusal(context, target!) };
    }
    if (action.operation === "resume_run") return finalizeOwnerResumeProjection(context.db, context.companyId,
      target!.workflowRunId, target!.stepRunId, projected);
    return projected;
  } // Operations share native exact recovery; promotion + retry is one atomic application.
  if (action.operation === "resume_run") return executeOwnerRunResume(context, request, resolvedActionId);
  if (action.operation === "revise_plan") return executeOwnerPlanAction(context, action.plan, resolvedActionId);
  if (action.operation === "recollect") return executeOwnerRecollect(context, request, resolvedActionId, validateIntent);
  if (action.operation === "delegate_fix") return executeOwnerDelegateFix(context, request, resolvedActionId, validateIntent);
  if (action.operation === "reassign") return executeOwnerReassign(context, request, resolvedActionId, validateIntent);
  if (action.operation === "promote_unblock_product") return executeOwnerUnblockPromotion(context, request, resolvedActionId, validateIntent);
  if (target === null) throw new OwnerActionRefusalError(422, "target_kind_not_supported"); // 타입 펜스: 위 분기가 revise_plan/recollect 을 이미 반환했다
  return dispatchOwnerExactRetry(context, request, target, resolvedActionId, validateIntent);
}
/** [Stage 1/3 exact 재시도 dispatch] retry_step 과 recollect same_configuration 이 공유하는 실행 경계다.
 *  issue_step 은 dispatchSourceIssueNativeResume(strict accept), tool_step 은 retryIssueLessToolWorkflowStep(strict)
 *  로 복구하고 권한 소비 영수증(applied event)을 1회 기록한 뒤 현재 상태를 투영한다. */
export async function dispatchOwnerExactRetry(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  target: OwnerStepTarget, actionId: string, validateIntent: (tx: Db) => Promise<boolean>): Promise<OwnerActionResult> {
  const [stepRun] = await context.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, target.stepRunId), eq(workflowStepRuns.workflowRunId, target.workflowRunId))).limit(1);
  if (!stepRun) refusal(404, "target_not_found");
  const reference = `${REFERENCE_PREFIX}${actionId}`;
  const issueDispatched = target.kind === "issue_step"
    ? (await dispatchSourceIssueNativeResume(context.db, {
        companyId: context.companyId, issueId: target.issueId, agentId: context.agentId, allowBlockedIssue: true,
        ownerExecution: { actionId, missionId: request.missionId, workflowRunId: target.workflowRunId, stepRunId: target.stepRunId,
          expectedAuthorityVersion: target.expectedAuthorityVersion, expectedExecutionGeneration: target.expectedExecutionGeneration,
          failedDispatchRequestId: target.failedDispatchRequestId, validateIntent },
      } satisfies AutomaticSourceResumeInput)).kind === "dispatched"
    : null;
  const toolNative = issueDispatched === null
    ? await retryIssueLessToolWorkflowStep(context.db, { companyId: context.companyId,
        runId: target.workflowRunId, stepId: stepRun.stepId, recoveryRequestReference: reference,
        expectedFailure: { stepRunId: target.stepRunId, authorityVersion: target.expectedAuthorityVersion,
          executionGeneration: target.expectedExecutionGeneration, dispatchRequestId: target.failedDispatchRequestId,
          ...(request.ownerDecisionEventId ? { ownerDecision: { ownerActionIssueId: request.ownerActionIssueId,
            decisionEventId: request.ownerDecisionEventId } } : {}) }, validateIntent })
    : null;  const [authority] = await context.db.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, context.companyId), eq(workflowRecoveryAuthorities.workflowRunId, target.workflowRunId),
    eq(workflowRecoveryAuthorities.recoveryKind, "supervision_tool_retry"), eq(workflowRecoveryAuthorities.requestReference, reference),
    eq(workflowRecoveryAuthorities.targetAuthorityVersion, target.expectedAuthorityVersion))).limit(1);
  if ((issueDispatched === false || (issueDispatched === null && !toolNative)) && !authority) {
    return { schemaVersion: 1, actionId, operation: request.action.operation, state: "blocked",
      reasonCode: await diagnoseRefusal(context, target), evidence: [evidenceItem("heartbeat", actionId,
        target.workflowRunId, target.stepRunId, target.expectedExecutionGeneration, null)], requiredAction: null };
  }
  // Native authority was consumed (or a crash left it applied-but-unrecorded) — record once, deliver only.
  const [after] = await context.db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(eq(workflowStepRuns.id, target.stepRunId)).limit(1);  await recordAppliedEvent(context.db, context.companyId, { actionId, operation: request.action.operation,
    missionId: request.missionId, workflowRunId: target.workflowRunId, stepRunId: target.stepRunId,
    authorityId: authority?.id ?? null, authorityVersion: after?.run.dispatchAuthorityVersion ?? null,
    executionGeneration: after?.stepRun.executionGeneration ?? null, dispatchRequestId: after?.stepRun.lastDispatchRequestId ?? null });
  await recoverDeliveryIfNeeded(context, request, actionId, validateIntent);
  return target.kind === "issue_step"
    ? projectIssueActionResult(context.db, context.companyId, request.missionId, actionId, target.issueId, request.action.operation)
    : projectOwnerActionResult(context.db, context.companyId, request.missionId, actionId, request.action.operation);
}
export async function getMissionOwnerActionResult(context: OwnerExecutionContext, request: MissionOwnerGetResultRequest): Promise<OwnerActionResult> {
  const [heartbeat] = await context.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.agentId, context.agentId))).limit(1);
  if (!heartbeat) refusal(403, "heartbeat_mismatch");
  const [intent] = await context.db.select({ missionId: workflowTransitionEvents.missionId,
    issueId: workflowTransitionEvents.issueId, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, request.actionId), eq(workflowTransitionEvents.companyId, context.companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"), eq(workflowTransitionEvents.layer, "mission_owner_authority"),
      eq(workflowTransitionEvents.reason, SOURCE))).limit(1);
  if (!intent || intent.missionId !== request.missionId) refusal(404, "action_not_found");
  const [mission] = await context.db.select({ ownerAgentId: missions.ownerAgentId }).from(missions)
    .where(and(eq(missions.id, request.missionId), eq(missions.companyId, context.companyId))).limit(1);
  if (!mission || mission.ownerAgentId !== context.agentId) refusal(403, "not_mission_owner");
  const intentAction = record(record(intent.payload).action);
  const intentTarget = record(intentAction.operation === "recollect" ? intentAction.collectorTarget
    : intentAction.operation === "delegate_fix" ? intentAction.producerTarget : intentAction.target);
  const operation = (intentAction.operation ?? "retry_step") as MissionOwnerAction["operation"];
  const projected = operation === "reassign"
    ? await projectOwnerReassignResult(context.db, context.companyId, request.missionId, request.actionId)
    : operation === "recollect"
    ? await projectOwnerRecollectResult(context.db, context.companyId, request.missionId, request.actionId)
    : operation === "delegate_fix"
      ? await projectOwnerDelegateFixResult(context.db, context.companyId, request.missionId, request.actionId)
      : operation === "revise_plan"
        ? await projectOwnerPlanActionResult(context.db, context.companyId, request.missionId, request.actionId)
        : intentTarget.kind === "issue_step" && typeof intentTarget.issueId === "string"
          ? await projectIssueActionResult(context.db, context.companyId, request.missionId, request.actionId,
            intentTarget.issueId as string, operation)
          : await projectOwnerActionResult(context.db, context.companyId, request.missionId, request.actionId, operation);
  if (operation !== "resume_run") return projected;
  // [Stage 4] 미적용 resume 액션의 get-result 는 최신 구조 사유로, 적용 액션은 anchor 범위 투영으로.
  if (projected.reasonCode === "action_not_applied") {
    const preview = await previewOwnerNativeRunResume(context, { schemaVersion: 1, missionId: request.missionId,
      ownerActionIssueId: intent.issueId ?? request.actionId, actionRequestId: request.actionId, expectedIntentEventId: null,
      ownerDecisionEventId: null, action: intentAction as unknown as MissionOwnerExecuteRequest["action"] });
    return { ...projected, reasonCode: preview.reasonCode };
  }
  return finalizeOwnerResumeProjection(context.db, context.companyId, String(intentTarget.workflowRunId ?? ""),
    String(intentTarget.stepRunId ?? ""), projected);
}
