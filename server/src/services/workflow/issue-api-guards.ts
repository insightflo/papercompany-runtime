/** Shared with the workflow HTTP authorizer. These checks never adopt checkout. */
export function isWorkflowApiIssue(issue: { originKind: string | null }) {
  return issue.originKind === "workflow_execution";
}
export function isDirectWorkflowApiAssignee(issue: { status: string; assigneeAgentId: string | null }, agentId: string) {
  return issue.status === "in_progress" && issue.assigneeAgentId === agentId;
}
