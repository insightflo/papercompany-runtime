export type OperatorDecisionPriority = "critical" | "high" | "medium" | "low";
export type OperatorDecisionInteractionType = "single_select" | "multi_select" | "action";
export type OperatorDecisionOutcome = "submit" | "approve" | "reject" | "hold";
export type OperatorDecisionStatus = "pending" | "resolved" | "cancelled";
export type OperatorDecisionContinuationMode = "none" | "issue_current_assignee";
export type OperatorDecisionContinuationState = "pending" | "leased" | "accepted" | "blocked" | "exhausted";
export type OperatorDecisionEffectiveStatus =
  | "pending"
  | "dispatching"
  | "blocked"
  | "exhausted"
  | "queued"
  | "deferred"
  | "running"
  | "coalesced"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "agent_unrunnable"
  | "assignee_changed"
  | "issue_terminal";

export interface OperatorDecisionFact {
  label: string;
  value: string;
  status: "known" | "unknown";
}

export interface OperatorDecisionEvidenceRef {
  label: string;
  href: string;
}

export interface OperatorDecisionOption {
  id: string;
  label: string;
  description: string | null;
  facts: OperatorDecisionFact[];
  evidenceRefs: OperatorDecisionEvidenceRef[];
}

export interface OperatorDecisionAction {
  id: string;
  label: string;
  outcome: OperatorDecisionOutcome;
  tone: "primary" | "neutral" | "danger";
  requiresSelection: boolean;
}

export interface OperatorDecisionDefinition {
  options: OperatorDecisionOption[];
  actions: OperatorDecisionAction[];
  selection: { min: number; max: number } | null;
  comment: {
    mode: "disabled" | "optional" | "required";
    label: string | null;
    placeholder: string | null;
    maxLength: number;
  };
  approvedScope: string[];
  forbiddenScope: string[];
}

export interface OperatorDecisionResult {
  actionId: string;
  outcome: OperatorDecisionOutcome;
  selectedOptionIds: string[];
  comment: string | null;
}

export interface OperatorDecisionSourceContext {
  missionId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  artifactRefs: { label: string; uri: string }[];
}

export interface OperatorDecisionContinuationView {
  id: string;
  state: OperatorDecisionContinuationState;
  generation: number;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount: number;
  maxManualRetries: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  targetAgentId: string | null;
  wakeupRequestId: string | null;
  effectiveStatus: OperatorDecisionEffectiveStatus;
  errorCode: string | null;
}

export interface OperatorDecisionView {
  id: string;
  companyId: string;
  schemaVersion: 1;
  requestKey: string;
  status: OperatorDecisionStatus;
  priority: OperatorDecisionPriority;
  interactionType: OperatorDecisionInteractionType;
  title: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceContext: OperatorDecisionSourceContext;
  definition: OperatorDecisionDefinition;
  result: OperatorDecisionResult | null;
  issueId: string | null;
  continuationMode: OperatorDecisionContinuationMode;
  requestedBy: { type: "agent" | "user"; id: string } | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  continuation: OperatorDecisionContinuationView | null;
}

export interface CreateOperatorDecisionInput {
  schemaVersion: 1;
  requestKey: string;
  priority: OperatorDecisionPriority;
  interactionType: OperatorDecisionInteractionType;
  title: string;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceContext: OperatorDecisionSourceContext;
  definition: OperatorDecisionDefinition;
  issueId: string | null;
  continuationMode: OperatorDecisionContinuationMode;
}
