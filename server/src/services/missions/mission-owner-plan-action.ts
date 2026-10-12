// server/src/services/missions/mission-owner-plan-action.ts
//
// [Stage 5] 오너 revise_plan 실행: 실재하는 동일 company/mission 의 mission_main_executor_plan
//   planning issue 와 현재 오너 권한을 확인하고, 구조적 decision 객체를 기존 native 제출 체인
//   (submitMissionOwnerPlanDecision → 검증/PLAN-QA 게이트/materialization)에 그대로 전달한다.
//   임시 issue·가짜 originKind·heartbeat 위장 없음. 제출 대기는 실행 성공이 아니며, 결과 투영은
//   활성 plan refs(ownerPlanDecision/planQa/paqoWorkflow)와 실제 run/step 상태만 읽는다.
import { and, eq } from "drizzle-orm";
import { issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { MissionOwnerAction } from "@paperclipai/shared/validators/mission-owner-authority";
import { missionPlanArtifactService } from "../mission-plan-artifacts.js";
import { submitMissionOwnerPlanDecision } from "./mission-plan-decision-agent-api.js";
import { hashOwnerPlanDecision } from "../mission-owner-plan-decisions.js";
import type { OwnerActionResult } from "./mission-owner-execution-state.js";
import { ownerPlanExecutionIntentCurrent } from "./mission-owner-execution-state.js";
import { OwnerActionRefusalError, type OwnerExecutionContext } from "./mission-owner-execute.js";

export type OwnerPlanInput = Extract<MissionOwnerAction, { operation: "revise_plan" }>["plan"];
type DecisionHash = Parameters<typeof hashOwnerPlanDecision>[0];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const planEvidence = (decisionHash: string | null, workflowRunId: string | null) =>
  ({ kind: "plan" as const, recordId: decisionHash ?? "", workflowRunId, stepRunId: null,
    executionGeneration: null, requestId: null });

/** 이 action 이 소유한 계획의 decisionHash 를 intent 원문에서 다시 계산한다(저장 값 자체가 권한이 아니다).
 *  [C1-a] delegate_fix 의 변경 수집 계획은 action.collection.plan.decision 에 있다 — 최상위 plan 우선, 폴백으로 읽는다. */
async function intentPlanHash(db: Db, companyId: string, actionId: string): Promise<string | null> {
  const [intent] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, actionId), eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"),
      eq(workflowTransitionEvents.layer, "mission_owner_authority"))).limit(1);
  const action = record(record(intent?.payload).action);
  const decision = [record(record(action.plan).decision), record(record(record(action.collection).plan).decision)]
    .find((candidate) => Object.keys(candidate).length > 0);
  return decision ? hashOwnerPlanDecision(decision as DecisionHash) : null;
}

export async function projectOwnerPlanActionResult(db: Db, companyId: string, missionId: string,
  actionId: string): Promise<OwnerActionResult> {
  const base = { schemaVersion: 1 as const, actionId, operation: "revise_plan" as const, requiredAction: null };
  const planHash = await intentPlanHash(db, companyId, actionId);
  if (planHash === null) return { ...base, state: "blocked", reasonCode: "plan_intent_missing",
    evidence: [planEvidence(null, null)] };
  const refs = record((await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId }))?.refs);
  const planQa = record(refs.planQa), paqo = record(refs.paqoWorkflow);
  const activeHash = typeof record(refs.ownerPlanDecision).decisionHash === "string"
    ? record(refs.ownerPlanDecision).decisionHash as string : null;
  const runId = typeof paqo.workflowRunId === "string" ? paqo.workflowRunId : null;
  if (runId && paqo.decisionHash === planHash) { // 이 action 의 계획이 만든 실제 run 투영
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const dispatches = steps.filter((step) => step.lastDispatchRequestId).map((step) =>
      ({ kind: "dispatch" as const, recordId: step.lastDispatchRequestId ?? "", workflowRunId: runId,
        stepRunId: step.id, executionGeneration: step.executionGeneration, requestId: step.lastDispatchRequestId }));
    const evidence = [planEvidence(planHash, runId), ...dispatches];
    const [run] = await db.select({ status: workflowRuns.status, startedAt: workflowRuns.startedAt,
      metadata: workflowRuns.metadata }).from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))).limit(1);
    if (!run) return { ...base, state: "needs_evidence", reasonCode: "plan_run_missing", evidence,
      requiredAction: { kind: "wait_active_execution", targetId: runId, reasonCode: "plan_run_missing" } };
    if (run.status === "completed" || (steps.length > 0 && steps.every((step) => step.status === "completed")))
      return { ...base, state: "resolved", reasonCode: null, evidence }; // 실제 실행 완료 기반
    if (steps.some((step) => step.status === "failed"))
      return { ...base, state: "blocked", reasonCode: "plan_step_failed", evidence };
    if (run.status === "running" || steps.some((step) => step.status === "running"))
      return { ...base, state: "executing", reasonCode: null, evidence };
    // [PR367 R3] 미시작 pending run 이 이 계획을 가리키는데 소유 intent 가 더 이상 현재가 아니면,
    //   새 요청은 조용한 delivery_pending 이 아니라 정확한 구조 거부를 받는다(현재면 ensure 경로가
    //   이미 native 시작했다). 무연결 run 은 기존 투영 그대로다.
    if (run.status === "pending" && run.startedAt == null
      && !(await ownerPlanExecutionIntentCurrent(db, companyId, { runMetadata: run.metadata })))
      return { ...base, state: "blocked", reasonCode: "owner_plan_start_intent_stale", evidence };
    return { ...base, state: "delivery_pending", reasonCode: null, evidence };
  }
  if (paqo.awaitingBoardStart === true && (activeHash === planHash || paqo.decisionHash === planHash))
    return { ...base, state: "blocked", reasonCode: "board_revision_start_required",
      evidence: [planEvidence(planHash, null)],
      requiredAction: { kind: "board_revision_start", targetId: actionId, reasonCode: "board_revision_start_required" } };
  if (activeHash === planHash) { // 이 action 의 계획이 활성이다: QA 상태가 다음 경계를 정한다
    const issueId = typeof planQa.issueId === "string" ? planQa.issueId : "";
    if (planQa.status === "pending") return { ...base, state: "applied", reasonCode: "plan_qa_pending",
      evidence: [planEvidence(planHash, null)],
      requiredAction: { kind: "submit_qa_verdict", targetId: issueId, reasonCode: "plan_qa_pending" } };
    if (planQa.status === "request_changes") return { ...base, state: "blocked",
      reasonCode: "plan_qa_changes_requested", evidence: [planEvidence(planHash, null)],
      requiredAction: { kind: "submit_corrected_plan", targetId: actionId, reasonCode: "plan_qa_changes_requested" } };
    return { ...base, state: "delivery_pending", reasonCode: null, evidence: [planEvidence(planHash, null)] };
  }
  return { ...base, state: "superseded", reasonCode: "plan_superseded", evidence: [planEvidence(planHash, null)] };
}

export async function executeOwnerPlanAction(context: OwnerExecutionContext, plan: OwnerPlanInput,
  actionId: string): Promise<OwnerActionResult> {
  const [planningIssue] = await context.db.select().from(issues).where(and(eq(issues.id, plan.planningIssueId),
    eq(issues.companyId, context.companyId))).limit(1);
  if (!planningIssue?.missionId || planningIssue.originKind !== "mission_main_executor_plan")
    throw new OwnerActionRefusalError(422, "planning_issue_not_found");
  const [mission] = await context.db.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
    .from(missions).where(and(eq(missions.id, planningIssue.missionId), eq(missions.companyId, context.companyId))).limit(1);
  if (!mission || mission.status !== "active" || mission.ownerAgentId !== context.agentId)
    throw new OwnerActionRefusalError(403, "not_mission_owner");
  if (plan.expectedDecisionHash !== null
    && hashOwnerPlanDecision(plan.decision as DecisionHash) !== plan.expectedDecisionHash)
    throw new OwnerActionRefusalError(422, "decision_hash_mismatch"); // 제출 본문과 핀의 불변 확인
  try {
    const result = await submitMissionOwnerPlanDecision({ db: context.db,
      issue: { id: planningIssue.id, companyId: planningIssue.companyId,
        missionId: planningIssue.missionId, originKind: planningIssue.originKind },
      actor: { actorType: "agent", actorId: context.agentId, runId: context.heartbeatRunId },
      decision: plan.decision });
    if (result.status === "plan_qa_pending") return { schemaVersion: 1, actionId, operation: "revise_plan",
      state: "applied", reasonCode: "plan_qa_pending", evidence: [planEvidence(result.decisionHash, null)],
      requiredAction: { kind: "submit_qa_verdict", targetId: result.planQaIssueId, reasonCode: "plan_qa_pending" } }; // 제출 대기는 성공이 아니다
    if (result.status === "plan_qa_changes_requested") return { schemaVersion: 1, actionId, operation: "revise_plan",
      state: "blocked", reasonCode: "plan_qa_changes_requested", evidence: [planEvidence(result.decisionHash, null)],
      requiredAction: { kind: "submit_corrected_plan", targetId: actionId, reasonCode: "plan_qa_changes_requested" } };
    if (result.status === "invalid") return { schemaVersion: 1, actionId, operation: "revise_plan",
      state: "blocked", reasonCode: result.reason ?? "invalid_decision", evidence: [planEvidence("decisionHash" in result ? result.decisionHash ?? null : null, null)],
      requiredAction: { kind: "submit_corrected_plan", targetId: actionId, reasonCode: result.reason ?? "invalid_decision" } };
    return await projectOwnerPlanActionResult(context.db, context.companyId, planningIssue.missionId, actionId); // recorded/noop → 현재 상태 투영
  } catch (error) { // native 구조 거부(예: 시작 경계 펜스)를 정확한 사유로 옮긴다. 자연어 파싱이 아니다.
    const message = error instanceof Error ? error.message : "";
    const reasonCode = /^[a-z0-9_]+$/.test(message) ? message : "plan_submission_failed";
    return { schemaVersion: 1, actionId, operation: "revise_plan", state: "blocked", reasonCode,
      evidence: [planEvidence(null, null)], requiredAction: null };
  }
}
