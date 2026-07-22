import type { WorkflowStep } from "../workflow/dag-engine.js";
import type { MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import { isIssueLessToolWorkflowStep } from "./tool-step-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function hasToolStepFailureExecutionEvidence(stepRun: {
  startedAt: Date | null;
  lastDispatchAttemptAt: Date | null;
  lastDispatchAcceptedAt: Date | null;
  lastDispatchErrorAt: Date | null;
  lastDispatchRequestId: string | null;
  metadata: unknown;
}): boolean {
  if (
    stepRun.startedAt
    || stepRun.lastDispatchAttemptAt
    || stepRun.lastDispatchAcceptedAt
    || stepRun.lastDispatchErrorAt
    || (typeof stepRun.lastDispatchRequestId === "string" && stepRun.lastDispatchRequestId.trim().length > 0)
  ) return true;
  const metadata = record(stepRun.metadata);
  return Object.keys(record(metadata.toolInvocation)).length > 0
    || Object.keys(record(metadata.toolResult)).length > 0
    || Object.keys(record(metadata.retentionDeleted)).length > 0;
}

export function issueLessToolRecoveryOwnsFailure(
  row: MissionSupervisionWorkflowStepRow,
): boolean {
  const workflowSteps = (row.definition.stepsJson as WorkflowStep[] | null) ?? [];
  const workflowStep = workflowSteps.find((step) => step.id === row.stepRun.stepId) ?? null;
  if (!isIssueLessToolWorkflowStep(workflowStep, row.stepRun.issueId)) return false;
  if (row.stepRun.status !== "failed") return false;
  if (!hasToolStepFailureExecutionEvidence(row.stepRun)) return false;
  return record(row.stepRun.metadata).workflowRetryExhaustion === undefined;
}
