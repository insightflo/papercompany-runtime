export type MissionPlanQaVerdictValue = "pass" | "request_changes";

export interface MissionPlanDecisionSubmissionPayload {
  kind: "mission_plan_decision";
  missionId: string;
  planningIssueId?: string | null;
  decision: Record<string, unknown>;
}

export interface MissionPlanQaVerdictPayload {
  kind: "mission_plan_qa_verdict";
  missionId: string;
  planQaIssueId: string;
  decisionHash: string;
  verdict: MissionPlanQaVerdictValue;
  diagnostics?: Array<Record<string, unknown>>;
}

export interface WorkflowValidationVerdictPayload {
  kind: "workflow_validation_verdict";
  workflowRunId: string;
  stepRunId: string;
  issueId: string;
  verdict: MissionPlanQaVerdictValue;
  diagnostics?: Array<Record<string, unknown>>;
}

export interface WorkflowTransitionEventPayload {
  kind: "workflow_transition_event";
  eventType:
    | "dag_step_runnable"
    | "dag_step_skipped"
    | "loop_rework_accepted"
    | "loop_rework_rejected"
    | "queue_requested"
    | "queue_accepted"
    | "queue_waiting"
    | "queue_rejected"
    | "queue_run_started"
    | "queue_run_completed";
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  issueId?: string | null;
  wakeupRequestId?: string | null;
  heartbeatRunId?: string | null;
  decision?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

export interface ExecutionQueueDecisionPayload {
  kind: "execution_queue_decision";
  wakeupRequestId: string;
  decision: "accepted" | "rejected" | "waiting";
  reason: string;
  issueId?: string | null;
  missionId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  heartbeatRunId?: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseMissionPlanDecisionSubmissionPayload(value: unknown): MissionPlanDecisionSubmissionPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "mission_plan_decision") return null;
  if (typeof value.missionId !== "string" || value.missionId.length === 0) return null;
  if (!isRecord(value.decision)) return null;
  return {
    kind: "mission_plan_decision",
    missionId: value.missionId,
    planningIssueId: typeof value.planningIssueId === "string" ? value.planningIssueId : null,
    decision: value.decision,
  };
}

export function parseMissionPlanQaVerdictPayload(value: unknown): MissionPlanQaVerdictPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "mission_plan_qa_verdict") return null;
  if (typeof value.missionId !== "string" || value.missionId.length === 0) return null;
  if (typeof value.planQaIssueId !== "string" || value.planQaIssueId.length === 0) return null;
  if (typeof value.decisionHash !== "string" || value.decisionHash.length === 0) return null;
  if (value.verdict !== "pass" && value.verdict !== "request_changes") return null;
  return {
    kind: "mission_plan_qa_verdict",
    missionId: value.missionId,
    planQaIssueId: value.planQaIssueId,
    decisionHash: value.decisionHash,
    verdict: value.verdict,
    diagnostics: Array.isArray(value.diagnostics)
      ? value.diagnostics.filter(isRecord)
      : [],
  };
}
