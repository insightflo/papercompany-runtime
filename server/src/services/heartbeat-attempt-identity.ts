import type { heartbeatRuns } from "@paperclipai/db";

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
