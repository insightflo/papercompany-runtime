// server/src/services/missions/mission-owner-reassign.ts
//
// [Stage 8] 오너 담당 변경(reassign) 실행: 담당 표시만 바꾸지 않고 실제 실행자까지 일치시킨다.
//   - 이슈 기반 대상(정의가 실행자를 고정하지 않음): 기존 담당 변경의 guarded 안전 검사를 재사용한
//     자동 재배정(applyAutomaticReassignSourceIssue — legacy human marker 와 멱원 분리) + stage3 strict
//     native 깨움(dispatchSourceIssueNativeResume ownerExecution)으로 새 담당자가 실제 실행을 시작한다.
//   - frozen step.agentId 대상(또는 tool_step): 재배정만으론 실제 실행자가 바뀌지 않는다 — stage5 제한된
//     계획 unit(새 agent 를 실행자로 지정)로 새 불변 정의를 만들어 실제 실행을 연결한다. 과거 정의의
//     step.agentId 는 절대 수정하지 않는다. 진행 중 기존 작업은 정확한 대기(병렬 시작 금지), 상태 부족은
//     request_access, revision 미션(sourceMissionId)은 기존 board fresh/seed 대기 보존 — ordinary 경로에
//     새 board gate 를 추가하지 않는다.
//   - resolved 는 이슈 담당자·accepted wake·실제 heartbeat agent 가 모두 새 담당자와 일치할 때뿐이다.
//     old agent 의 지연 결과는 새 시도를 완성시키지 못한다(자연어·표시 상태는 근거가 아니다).
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests, agents, heartbeatRuns, issues, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { MissionOwnerAction, MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import {
  describeMissionExecutionLiaisonBoundary, isMissionExecutionLiaisonAgent, isRunnableMissionExecutionAssigneeStatus,
} from "./agent-role-boundaries.js";
import { APPLIED_EVENT, INTENT_EVENT, loadAppliedPayload, recordAppliedEvent, type OwnerActionResult } from "./mission-owner-execution-state.js";
import { OwnerActionRefusalError, type OwnerExecutionContext } from "./mission-owner-execute.js";
import { executeOwnerPlanAction, projectOwnerPlanActionResult } from "./mission-owner-plan-action.js";
import { applyAutomaticReassignSourceIssue } from "./mission-owner-reassign-source.js";
import { dispatchSourceIssueNativeResume, type AutomaticSourceResumeInput } from "../workflow/source-issue-native-resume.js";

export type OwnerReassignAction = Extract<MissionOwnerAction, { operation: "reassign" }>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const evidence = (kind: "authority" | "dispatch" | "heartbeat", recordId: string | null,
  workflowRunId: string | null, stepRunId: string | null, executionGeneration: number | null, requestId: string | null) =>
  ({ kind, recordId: recordId ?? "", workflowRunId, stepRunId, executionGeneration, requestId });
const relabelReassign = (result: OwnerActionResult): OwnerActionResult =>
  result.operation === "reassign" ? result : { ...result, operation: "reassign" as const };
const blocked = (actionId: string, reasonCode: string, workflowRunId: string, stepRunId: string,
  requiredAction: OwnerActionResult["requiredAction"]): OwnerActionResult => ({ schemaVersion: 1, actionId,
  operation: "reassign", state: "blocked", reasonCode,
  evidence: [evidence("heartbeat", actionId, workflowRunId, stepRunId, null, null)], requiredAction });

/** 런의 정의에서 이 스텝의 고정 실행자(step.agentId)를 읽는다. 없으면 이슈 담당자가 실행자다. */
async function loadTargetRow(db: Db, companyId: string, missionId: string, target: OwnerReassignAction["target"]) {
  const [row] = await db.select({ stepRun: workflowStepRuns, run: workflowRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, target.stepRunId), eq(workflowStepRuns.workflowRunId, target.workflowRunId),
      eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId))).limit(1);
  if (!row) return null;
  const [definition] = await db.select({ stepsJson: workflowDefinitions.stepsJson }).from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, row.run.workflowId), eq(workflowDefinitions.companyId, companyId))).limit(1);
  const step = ((definition?.stepsJson ?? []) as unknown[]).map(record)
    .find((candidate) => candidate.id === row.stepRun.stepId) ?? null;
  const frozenAgentId = typeof step?.agentId === "string" && step.agentId.trim() ? step.agentId.trim() : null;
  return { ...row, frozenAgentId };
}

/** 재배정만으로 실제 실행자가 바뀌는가? — 정의가 실행자를 고정하지 않은 이슈 스텝만 해당한다(술어로 narrow). */
type IssueStepReassignTarget = Extract<OwnerReassignAction["target"], { kind: "issue_step" }>;
const rebindableByAssignee = (target: OwnerReassignAction["target"], frozenAgentId: string | null,
  targetAgentId: string): target is IssueStepReassignTarget =>
  target.kind === "issue_step" && (frozenAgentId === null || frozenAgentId === targetAgentId);

/** [preflight] intent 기록 전 구조 검증(전부 읽기 전용 — 위반은 404/409/422 부작용 0 거부). */
export async function preflightOwnerReassign(context: OwnerExecutionContext,
  request: MissionOwnerExecuteRequest): Promise<void> {
  const action = request.action;
  if (action.operation !== "reassign") return;
  const [agent] = await context.db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.companyId, context.companyId), eq(agents.id, action.targetAgentId))).limit(1);
  if (!agent) throw new OwnerActionRefusalError(404, "target_agent_not_found"); // 무작정 targetAgentId 사전 거부
  const row = await loadTargetRow(context.db, context.companyId, request.missionId, action.target);
  if (!row) throw new OwnerActionRefusalError(404, "target_not_found");
  if (action.target.expectedAuthorityVersion !== row.run.dispatchAuthorityVersion) throw new OwnerActionRefusalError(409, "stale_authority_version");
  if (action.target.expectedExecutionGeneration !== row.stepRun.executionGeneration) throw new OwnerActionRefusalError(409, "stale_generation");
  if (rebindableByAssignee(action.target, row.frozenAgentId, action.targetAgentId)) return;
  if (!action.plan) throw new OwnerActionRefusalError(422, "plan_required"); // frozen step.agentId/tool_step: 새 불변 정의가 필수다
  const [planning] = await context.db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, action.plan.planningIssueId),
    eq(issues.companyId, context.companyId), eq(issues.missionId, request.missionId),
    eq(issues.originKind, "mission_main_executor_plan"))).limit(1);
  if (!planning) throw new OwnerActionRefusalError(404, "planning_issue_not_found");
  const unitsRaw = record(action.plan.decision).selectedExecutionUnits;
  const units: unknown[] = Array.isArray(unitsRaw) ? unitsRaw : [];
  if (!units.some((unit) => record(unit).assigneeAgentId === action.targetAgentId))
    throw new OwnerActionRefusalError(422, "plan_target_mismatch"); // 제한된 계획 unit 이 새 agent 를 실행자로 지정했는지 구조 확인
}

/** [투영] intent 원문에서 경로를 재유도해 현재 상태만 읽는다. 표시 담당자 변경만으로 resolved 금지. */
export async function projectOwnerReassignResult(db: Db, companyId: string, missionId: string,
  actionId: string): Promise<OwnerActionResult> {
  const [intent] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, actionId), eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, INTENT_EVENT),
      eq(workflowTransitionEvents.layer, "mission_owner_authority"))).limit(1);
  const action = record(record(intent?.payload).action);
  const target = record(action.target);
  const targetAgentId = typeof action.targetAgentId === "string" ? action.targetAgentId : "";
  const base = { schemaVersion: 1 as const, actionId, operation: "reassign" as const, requiredAction: null };
  const workflowRunId = typeof target.workflowRunId === "string" ? target.workflowRunId : "";
  const stepRunId = typeof target.stepRunId === "string" ? target.stepRunId : "";
  const issueId = typeof target.issueId === "string" ? target.issueId : "";
  const row = workflowRunId && stepRunId ? await loadTargetRow(db, companyId, missionId,
    { ...(target as unknown as OwnerReassignAction["target"]) }) : null;
  if (record(action.plan).decision && !rebindableByAssignee(target as unknown as OwnerReassignAction["target"],
    row?.frozenAgentId ?? null, targetAgentId))
    return relabelReassign(await projectOwnerPlanActionResult(db, companyId, missionId, actionId)); // frozen→새 정의 경로
  const [appliedRow] = await db.select({ createdAt: workflowTransitionEvents.createdAt })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, APPLIED_EVENT), eq(workflowTransitionEvents.layer, "mission_owner_authority"),
      eq(workflowTransitionEvents.reason, "mission_owner_execute"),
      eq(workflowTransitionEvents.correlationId, actionId))).limit(1);
  if (!appliedRow) {
    if (issueId) {
      const [live] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.issueId, issueId),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced"]))).limit(1);
      const [liveHeartbeat] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
        inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
      if (live || liveHeartbeat) return { ...base, state: "blocked", reasonCode: "reassign_target_in_flight",
        evidence: [evidence("heartbeat", actionId, workflowRunId, stepRunId, null, null)],
        requiredAction: { kind: "wait_active_execution", targetId: issueId, reasonCode: "reassign_target_in_flight" } };
    }
    return { ...base, state: "blocked", reasonCode: "action_not_applied",
      evidence: [evidence("heartbeat", actionId, workflowRunId, stepRunId, null, null)], requiredAction: null };
  }
  const appliedAt = appliedRow.createdAt ?? new Date(0);
  const ev = [evidence("heartbeat", actionId, workflowRunId, stepRunId, null, null)];
  const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId),
    eq(issues.companyId, companyId))).limit(1) : [null];
  if (!issue || issue.assigneeAgentId !== targetAgentId)
    return { ...base, state: "superseded", reasonCode: "assignee_changed", evidence: ev, requiredAction: null };
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).limit(1);
  if (!step) return { ...base, state: "needs_evidence", reasonCode: "attempt_record_missing", evidence: ev,
    requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "attempt_record_missing" } };
  const [acceptedWake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
    eq(agentWakeupRequests.issueId, issueId), eq(agentWakeupRequests.agentId, targetAgentId),
    eq(agentWakeupRequests.requestKind, "workflow_resume"))).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
  if (acceptedWake) ev.push(evidence("dispatch", acceptedWake.id, acceptedWake.workflowRunId,
    acceptedWake.workflowStepRunId, step.executionGeneration, acceptedWake.id)); // 새 담당자에게 받아들여진 깨움
  if (step.status === "completed") {
    const [executorHeartbeat] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
      eq(heartbeatRuns.agentId, targetAgentId), eq(heartbeatRuns.status, "succeeded")))
      .orderBy(desc(heartbeatRuns.startedAt)).limit(1);
    if (executorHeartbeat && (!executorHeartbeat.startedAt || executorHeartbeat.startedAt >= appliedAt))
      return { ...base, state: "resolved", reasonCode: null,
        evidence: [...ev, evidence("heartbeat", executorHeartbeat.id, workflowRunId, stepRunId, step.executionGeneration, null)] };
    return { ...base, state: "needs_evidence", reasonCode: "completed_by_prior_agent", evidence: ev,
      requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "completed_by_prior_agent" } }; // old agent 지연 결과 미인정
  }
  if (step.status === "failed") return { ...base, state: "blocked", reasonCode: "step_execution_failed", evidence: ev, requiredAction: null };
  if (step.status === "running") {
    const [live] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
      inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
    if (live || acceptedWake) return { ...base, state: "executing", reasonCode: null, evidence: ev };
    return { ...base, state: "delivery_pending", reasonCode: null, evidence: ev };
  }
  return { ...base, state: "delivery_pending", reasonCode: null, evidence: ev };
}

/** [실행] 분기: 이슈 기반은 guarded 재배정+native 깨움, frozen/tool_step 은 stage5 제한된 계획 체인. */
export async function executeOwnerReassign(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>): Promise<OwnerActionResult> {
  const action = request.action;
  if (action.operation !== "reassign") throw new Error("reassign_operation_required");
  const row = await loadTargetRow(context.db, context.companyId, request.missionId, action.target);
  if (!row) throw new OwnerActionRefusalError(404, "target_not_found");
  const [agent] = await context.db.select({ id: agents.id, name: agents.name, status: agents.status,
    adapterType: agents.adapterType, runtimeConfig: agents.runtimeConfig, metadata: agents.metadata })
    .from(agents).where(and(eq(agents.companyId, context.companyId), eq(agents.id, action.targetAgentId))).limit(1);
  if (!agent) throw new OwnerActionRefusalError(404, "target_agent_not_found");
  if (!isRunnableMissionExecutionAssigneeStatus(agent.status)) // 상태 부족 → 정확한 권한 요청, 실행 부작용 0
    return { schemaVersion: 1, actionId, operation: "reassign", state: "blocked", reasonCode: "target_agent_not_runnable",
      evidence: [evidence("heartbeat", actionId, action.target.workflowRunId, action.target.stepRunId, null, null)],
      requiredAction: { kind: "request_access", targetId: agent.id, reasonCode: "target_agent_not_runnable" } };
  if (isMissionExecutionLiaisonAgent(agent)) return { schemaVersion: 1, actionId, operation: "reassign",
    state: "blocked", reasonCode: "target_agent_liaison",
    evidence: [evidence("heartbeat", actionId, action.target.workflowRunId, action.target.stepRunId, null, null)],
    requiredAction: { kind: "request_access", targetId: agent.id,
      reasonCode: describeMissionExecutionLiaisonBoundary(agent) } };
  if (!rebindableByAssignee(action.target, row.frozenAgentId, action.targetAgentId)) {
    if (!action.plan) throw new OwnerActionRefusalError(422, "plan_required"); // preflight 와 같은 계약 재확인
    return relabelReassign(await executeOwnerPlanAction(context, action.plan, actionId));
  }
  if (["completed", "skipped", "cancelled", "canceled"].includes(row.stepRun.status))
    return blocked(actionId, "step_terminal", action.target.workflowRunId, action.target.stepRunId, null);
  if (row.run.status !== "running" && row.run.status !== "failed")
    return blocked(actionId, "run_not_active", action.target.workflowRunId, action.target.stepRunId, null);
  const applied = await applyAutomaticReassignSourceIssue({ db: context.db, companyId: context.companyId,
    missionId: request.missionId, issueId: action.target.issueId, targetAgentId: action.targetAgentId,
    ownerExecution: { actionId, missionId: request.missionId, workflowRunId: action.target.workflowRunId,
      stepRunId: action.target.stepRunId, expectedAuthorityVersion: row.run.dispatchAuthorityVersion,
      expectedExecutionGeneration: row.stepRun.executionGeneration,
      failedDispatchRequestId: action.target.failedDispatchRequestId, validateIntent } });
  if (applied.kind === "not_applied") {
    if (applied.reasonCode === "reassign_target_in_flight")
      return { schemaVersion: 1, actionId, operation: "reassign", state: "blocked", reasonCode: applied.reasonCode,
        evidence: [evidence("heartbeat", actionId, action.target.workflowRunId, action.target.stepRunId, null, null)],
        requiredAction: { kind: "wait_active_execution", targetId: action.target.issueId,
          reasonCode: "reassign_target_in_flight" } }; // 진행 중 기존 작업 — 병렬 시작 없이 정확한 대기
    return blocked(actionId, applied.reasonCode ?? "reassign_not_applied",
      action.target.workflowRunId, action.target.stepRunId, null);
  }
  await recordAppliedEvent(context.db, context.companyId, { actionId, operation: "reassign",
    missionId: request.missionId, workflowRunId: action.target.workflowRunId, stepRunId: action.target.stepRunId,
    authorityId: null, authorityVersion: row.run.dispatchAuthorityVersion,
    executionGeneration: row.stepRun.executionGeneration, dispatchRequestId: row.stepRun.lastDispatchRequestId });
  const outcome = await dispatchSourceIssueNativeResume(context.db, {
    companyId: context.companyId, issueId: action.target.issueId, agentId: action.targetAgentId,
    allowBlockedIssue: true, ownerExecution: { actionId, missionId: request.missionId,
      workflowRunId: action.target.workflowRunId, stepRunId: action.target.stepRunId,
      expectedAuthorityVersion: row.run.dispatchAuthorityVersion,
      expectedExecutionGeneration: row.stepRun.executionGeneration,
      failedDispatchRequestId: action.target.failedDispatchRequestId, validateIntent },
  } satisfies AutomaticSourceResumeInput);
  if (outcome.kind === "report_only") return blocked(actionId,
    outcome.reason === "run_not_running" ? "run_not_active"
      : outcome.reason === "step_not_found" ? "step_missing_from_definition"
      : outcome.reason === "no_definition" ? "definition_missing" : "native_wake_rejected",
    action.target.workflowRunId, action.target.stepRunId, null);
  return projectOwnerReassignResult(context.db, context.companyId, request.missionId, actionId);
}
