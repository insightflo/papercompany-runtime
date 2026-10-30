import type { OperatorDecisionContinuationView, OperatorDecisionView } from "./operator-decision.js";

export type HumanOperatorRequestDecisionState = Pick<
  OperatorDecisionView,
  "id" | "requestKey" | "sourceId" | "status" | "result" | "resolvedAt" | "cancelledAt" | "continuationMode"
>;

export type HumanOperatorRequestContinuationState = Pick<
  OperatorDecisionContinuationView,
  | "id"
  | "state"
  | "generation"
  | "attemptCount"
  | "maxAttempts"
  | "manualRetryCount"
  | "maxManualRetries"
  | "wakeupRequestId"
  | "effectiveStatus"
  | "errorCode"
  | "retryHint"
>;

export type HumanOperatorRequestStateV1 = {
  schemaVersion: 1;
  identity: "exact" | "missing" | "ambiguous" | "unsupported";
  reasonCode: string | null;
  decisionEventId: string;
  ownerActionIssueId: string;
  sourceIssueId: string | null;
  decision: HumanOperatorRequestDecisionState | null;
  continuation: HumanOperatorRequestContinuationState | null;
  attention: boolean | null;
};
