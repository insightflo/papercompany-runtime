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
  /** [요청자 추천] 요청자(오너/시스템)가 선택지와 함께 제시하는 비구속 추천 표시.
 *  정의당 최대 1개 옵션에만 true — 검증기가 강제한다. 없으면 사람 판단에 그대로 남는다(기존 동작). */
  recommended?: boolean;
  /** 추천 사유 한 줄 — recommended 인 옵션에만 붙을 수 있다(검증기 강제). */
  recommendationReason?: string | null;
}

export interface OperatorDecisionAction {
  id: string;
  label: string;
  outcome: OperatorDecisionOutcome;
  tone: "primary" | "neutral" | "danger";
  requiresSelection: boolean;
}

export interface OperatorDecisionOptionGroup {
  id: string;
  label: string | null;
  optionIds: string[];
  selection: { min: number; max: number } | null;
}

export interface OperatorDecisionDefinition {
  options: OperatorDecisionOption[];
  optionGroups?: OperatorDecisionOptionGroup[] | null;
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
  humanReview?: import("./human-review.js").HumanReviewPacket | null;
}

export interface OperatorDecisionResult {
  actionId: string;
  outcome: OperatorDecisionOutcome;
  selectedOptionIds: string[];
  comment: string | null;
}

export interface OperatorDecisionTargetSnapshot {
  issueId?: string | null;
  issueStatus?: string | null;
  workflowRunId?: string | null;
  workflowRunStatus?: string | null;
  stepRunId?: string | null;
  stepRunStatus?: string | null;
  executionGeneration?: number | null;
}

export interface OperatorDecisionSourceContext {
  missionId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  artifactRefs: { label: string; uri: string }[];
  /** [currentness gate] 생성 시점 대상 상태 스냅샷 — resolve 시점에 서버가 같은 트랜잭션에서
   *  재검증해 늦은 선택을 409 target_changed 로 거부한다. 없으면 기존 동작(옵트인). */
  targetSnapshot?: OperatorDecisionTargetSnapshot | null;
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
  /** Operator-facing context for the linked issue — lets the attention list say
   *  WHICH mission/issue the retry belongs to without extra lookups. */
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  issueAssigneeAgentId: string | null;
  missionId: string | null;
  missionTitle: string | null;
  /** Human-readable hint for what retrying does next, derived from the blocked reason. */
  retryHint: string | null;
}

export type OperatorDecisionRequesterOutcomeStatus =
  | "acknowledged"
  | "in_progress"
  | "completed"
  | "failed"
  | "not_applied";

export interface OperatorDecisionRequesterOutcomeView {
  status: OperatorDecisionRequesterOutcomeStatus;
  reason: string | null;
  detail: string | null;
  reportedAt: string;
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
  /** Operator-facing labels for the linked issue/mission — pending card header context. */
  issueIdentifier: string | null;
  issueTitle: string | null;
  missionTitle: string | null;
  continuationMode: OperatorDecisionContinuationMode;
  requestedBy: { type: "agent" | "user"; id: string } | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  /** [4b-1] 요청자 회신 결과 투영 — resolved 카드의 최신 outcome activity 1건(pending/cancelled 는 null). */
  requesterOutcome?: OperatorDecisionRequesterOutcomeView | null;
  /** [4b-1] 취소 사유 투영 — cancelled 카드의 최신 cancel activity details.reason(예: target_changed). */
  cancellationReason?: string | null;
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
