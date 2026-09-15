import type { PlanQaWakeupHandler, PlanningIssueWakeupHandler } from "../mission-owner-plan-decisions.js";
import type { PlanQaResubmissionWakeDispatcher } from "./plan-qa-resubmission.js";
export type { PlanQaResubmissionWakeDispatcher } from "./plan-qa-resubmission.js";

type WakeupDeps = {
  wakeup: (agentId: string, opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation" | "scheduler";
    triggerDetail?: string | null;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  }) => Promise<unknown>;
};

export function createPlanQaWakeupHandler(
  heartbeat: WakeupDeps,
  opts: { requestedByActorId?: string; contextSource?: string } = {},
): PlanQaWakeupHandler {
  return (input) => heartbeat.wakeup(input.agentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    idempotencyKey: `mission-plan-qa:${input.issueId}:issue-assigned`,
    payload: {
      issueId: input.issueId,
      missionId: input.missionId,
      mutation: "create",
      originKind: "mission_plan_qa",
      ...(input.planningIssueId ? { planningIssueId: input.planningIssueId } : {}),
    },
    requestedByActorType: "system",
    requestedByActorId: opts.requestedByActorId ?? "mission-plan-qa",
    contextSnapshot: {
      issueId: input.issueId,
      missionId: input.missionId,
      source: opts.contextSource ?? "mission_plan_qa",
      originKind: "mission_plan_qa",
      ...(input.planningIssueId ? { planningIssueId: input.planningIssueId } : {}),
    },
  });
}

export function createPlanningIssueWakeupHandler(
  heartbeat: WakeupDeps,
  opts: { requestedByActorId?: string; contextSource?: string } = {},
): PlanningIssueWakeupHandler {
  return (input) => heartbeat.wakeup(input.agentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "mission_owner_plan_rework_requested",
    idempotencyKey: `mission-owner-plan-rework:${input.issueId}:${input.decisionHash}`,
    payload: {
      issueId: input.issueId,
      missionId: input.missionId,
      mutation: "mission_main_executor_plan",
      planQaIssueId: input.planQaIssueId,
      decisionHash: input.decisionHash,
    },
    requestedByActorType: "system",
    requestedByActorId: opts.requestedByActorId ?? "mission-owner-plan-rework",
    contextSnapshot: {
      issueId: input.issueId,
      missionId: input.missionId,
      source: opts.contextSource ?? "mission_owner_plan_rework",
      originKind: "mission_main_executor_plan",
      wakeReason: "mission_owner_plan_rework_requested",
      planQaIssueId: input.planQaIssueId,
      decisionHash: input.decisionHash,
      forceFreshSession: true,
    },
  });
}

/** [T8 bounded resubmission] 소명 누락 재제출 전용 wake. 초기 배정 콜백(mutation=create)과
 *  다른 idempotencyKey 를 쓰고, 예약 원장의 정확한 키로만 발행된다. 반환값은 수락 증거가 아니다. */
export function createPlanQaResubmissionWakeupHandler(
  heartbeat: WakeupDeps,
  opts: { requestedByActorId?: string; contextSource?: string } = {},
): PlanQaResubmissionWakeDispatcher {
  return (input) => heartbeat.wakeup(input.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "plan_qa_evidence_resubmission",
    idempotencyKey: input.intentKey,
    payload: {
      issueId: input.issueId,
      missionId: input.missionId,
      mutation: "plan_qa_evidence_resubmission",
      originKind: "mission_plan_qa",
      attempt: input.attempt,
    },
    requestedByActorType: "system",
    requestedByActorId: opts.requestedByActorId ?? "mission-plan-qa",
    contextSnapshot: {
      issueId: input.issueId,
      missionId: input.missionId,
      source: opts.contextSource ?? "plan_qa_evidence_resubmission",
      originKind: "mission_plan_qa",
      wakeReason: "plan_qa_evidence_resubmission",
      attempt: input.attempt,
    },
  });
}
