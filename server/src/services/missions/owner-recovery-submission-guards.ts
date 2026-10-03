import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";

type ToolTarget = Extract<OwnerRecoveryTarget, { kind: "tool_step" }>;
export function ownerRecoveryActorFailure(actor: OwnerRecoveryApiActor) {
  if (actor.actorType !== "agent" || !actor.agentId) return "agent_required";
  if (!actor.runId) return "run_required";
  return null;
}
export function ownerRecoveryIssueFailure(issue: { originKind: string | null; missionId: string | null }) {
  if (issue.originKind !== "mission_main_executor_unblock") return "unblock_required";
  if (!issue.missionId) return "mission_required";
  return null;
}
export function ownerRecoveryOwnerMatches(mission: { ownerAgentId: string | null } | undefined, agentId: string | null) {
  return Boolean(mission && mission.ownerAgentId === agentId);
}
export function ownerRecoverySourceMatches(source: { missionId: string | null } | undefined, missionId: string | null) {
  return Boolean(source && source.missionId === missionId);
}
export function ownerRecoveryRunMatches(run: { status: string; dispatchAuthorityVersion: number } | undefined, target: ToolTarget) {
  return Boolean(run && run.status === "failed" && run.dispatchAuthorityVersion === target.expectedAuthorityVersion);
}
export function ownerRecoveryStepMatches(step: { status: string; executionGeneration: number; lastDispatchRequestId: string | null } | undefined, target: ToolTarget) {
  return Boolean(step && step.status === "failed" && step.executionGeneration === target.expectedExecutionGeneration
    && step.lastDispatchRequestId === target.failedDispatchRequestId);
}
export function ownerRecoveryIdentityMatches(input: {
  heartbeat: { companyId: string; agentId: string; issueId: string | null } | undefined;
  issue: { id: string; companyId: string; missionId: string | null; originId: string | null; originKind: string | null };
  currentIssue: { companyId: string; missionId: string | null; originId: string | null; originKind: string | null } | undefined;
  agentId: string | null;
}) {
  const { heartbeat, issue, currentIssue, agentId } = input;
  return Boolean(heartbeat && heartbeat.companyId === issue.companyId && heartbeat.agentId === agentId
    && heartbeat.issueId === issue.id && currentIssue && currentIssue.companyId === issue.companyId
    && currentIssue.missionId === issue.missionId && currentIssue.originId === issue.originId
    && currentIssue.originKind === issue.originKind);
}
