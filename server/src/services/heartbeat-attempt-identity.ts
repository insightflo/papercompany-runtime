import type { HeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import type { heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";

export function sameHeartbeatExecutionAttempt(left: typeof heartbeatRuns.$inferSelect,
  right: typeof heartbeatRuns.$inferSelect) {
  return left.id === right.id && left.companyId === right.companyId && left.agentId === right.agentId
    && left.issueId === right.issueId && left.wakeupRequestId === right.wakeupRequestId
    && left.workflowStepRunId === right.workflowStepRunId
    && left.workflowExecutionGeneration === right.workflowExecutionGeneration
    && left.executionScopeKind === right.executionScopeKind && left.executionEpoch === right.executionEpoch
    && left.executionToken === right.executionToken && left.executorOwnerId === right.executorOwnerId
    && left.executorOwnerLeaseEpoch === right.executorOwnerLeaseEpoch
    && left.executorOwnerLeaseToken === right.executorOwnerLeaseToken && left.retryOfRunId === right.retryOfRunId
    && left.processLossRetryCount === right.processLossRetryCount;
}

export function heartbeatActualIdentityMatchesRun(identity: HeartbeatActualDrainIdentity,
  run: typeof heartbeatRuns.$inferSelect) {
  return identity.heartbeatRunId === run.id && identity.companyId === run.companyId
    && identity.issueId === run.issueId && identity.wakeupRequestId === run.wakeupRequestId
    && identity.workflowStepRunId === run.workflowStepRunId
    && identity.executionGeneration === run.workflowExecutionGeneration
    && identity.executionScopeKind === run.executionScopeKind && identity.executionEpoch === run.executionEpoch
    && identity.executionToken === run.executionToken && identity.executorOwnerId === run.executorOwnerId
    && identity.ownerLeaseEpoch === run.executorOwnerLeaseEpoch
    && identity.ownerLeaseToken === run.executorOwnerLeaseToken && identity.retryOfRunId === run.retryOfRunId
    && identity.processLossRetryCount === run.processLossRetryCount;
}

export function producedExecutionScopeKind(run: typeof heartbeatRuns.$inferSelect,
  wake: typeof agentWakeupRequests.$inferSelect | null) {
  if (wake?.workflowStepRunId && wake.workflowExecutionGeneration !== null) return "workflow_step";
  if (run.issueId) return "issue_nonworkflow";
  if (wake?.missionId) return "mission_nonworkflow";
  if (run.invocationSource === "timer") return "timer";
  if (run.invocationSource === "on_demand") return "manual_on_demand";
  return "automation_nonworkflow";
}
