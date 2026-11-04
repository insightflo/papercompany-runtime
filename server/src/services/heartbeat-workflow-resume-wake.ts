import { parseObject } from "../adapters/utils.js";

export function isWorkflowStepResumeWake(input: {
  requestKind?: unknown;
  reason?: unknown;
  payload?: unknown;
  contextSnapshot?: unknown;
}) {
  const payload = parseObject(input.payload);
  const contextSnapshot = parseObject(input.contextSnapshot);
  const kind = typeof input.requestKind === "string" ? input.requestKind : "";
  const mutation = typeof payload.mutation === "string" ? payload.mutation : "";
  const reason = typeof input.reason === "string" ? input.reason : "";
  const workflowRunId = typeof contextSnapshot.workflowRunId === "string"
    ? contextSnapshot.workflowRunId
    : typeof payload.workflowRunId === "string"
      ? payload.workflowRunId
      : "";
  const workflowStepRunId = typeof contextSnapshot.workflowStepRunId === "string"
    ? contextSnapshot.workflowStepRunId
    : typeof payload.workflowStepRunId === "string"
      ? payload.workflowStepRunId
      : "";
  return (
    (kind === "workflow_resume" || mutation === "workflow_resume" || reason === "workflow_step_runnable") &&
    workflowRunId.length > 0 &&
    workflowStepRunId.length > 0
  );
}
