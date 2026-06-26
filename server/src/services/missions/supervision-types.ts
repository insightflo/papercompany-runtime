// server/src/services/missions/supervision-types.ts
//
// [파일 목적] mission owner supervision(감독/회복 의사결정) 결과 표현 타입 모음.
//   missions.ts mega-file 회피를 위해 분리. supervision 루프가 반환하는 recommendation/appliedAction/result 형태.
// [외부 연결] consumer: missions.ts(supervision 함수). deps: MissionExecutionSourceRef, MissionOwnerActionExplanation.
// [수정시 주의] recommendation type 종류가 바뀌면 MissionOwnerSupervisionRecommendationType union과 supervision 분기 동기화.
import type { MissionExecutionSourceRef } from "./mission-execution-sources.js";
import { isRecord } from "./utils.js";
import type { MissionOwnerActionExplanation } from "./mission-owner-recovery-explanations.js";

export type MissionOwnerSupervisionRecommendationType =
  | "dispatch_missing_step"
  | "dispatch_missing_unit"
  | "retry_failed_step_if_safe"
  | "retry_unit_if_safe"
  | "request_replan"
  | "request_approval"
  | "escalate_blocked"
  | "materialize_plan_decision"
  | "materialize_artifact_from_comment"
  | "mark_impossible_with_evidence";

export type MissionOwnerSupervisionRecommendation = {
  type: MissionOwnerSupervisionRecommendationType;
  missionId: string;
  reason: string;
  safeToAutoApply: boolean;
  workflowRunId?: string;
  stepId?: string;
  issueId?: string;
  sourceRef?: MissionExecutionSourceRef;
};

export type MissionOwnerDecisionWakeupDispatchStatus = "not_requested" | "dispatched" | "workflow_already_dispatched" | "skipped_no_assignee" | "failed";

export type MissionOwnerDecisionWakeupDispatchResult = {
  status?: MissionOwnerDecisionWakeupDispatchStatus;
  runId?: string | null;
  workflowWakeupRequestId?: string;
};

export type MissionOwnerSupervisionAppliedAction = {
  type: "dispatch_missing_step";
  missionId: string;
  workflowRunId: string;
  stepIds: string[];
  resultStatus: string;
} | {
  type: "owner_decision_retry_source_issue";
  missionId: string;
  ownerActionIssueId: string;
  sourceIssueId: string;
  resultStatus: string;
  wakeupDispatchStatus?: MissionOwnerDecisionWakeupDispatchStatus;
  idempotencyKey?: string;
} | {
  type: "materialize_plan_decision";
  missionId: string;
  resultStatus: string;
  planningIssueId: string | null;
  workflowRunId?: string;
} | {
  type: "native_tool_step_retry";
  missionId: string;
  ownerActionIssueId: string;
  workflowRunId: string;
  stepId: string;
  stepRunId: string;
  resultStatus: string;
} | {
  type: "stale_source_issue_wakeup";
  missionId: string;
  sourceIssueId: string;
  failedRunId: string;
  resultStatus: string;
  wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus;
  idempotencyKey: string;
} | {
  type: "workproduct_reuse_wakeup";
  missionId: string;
  sourceIssueId: string;
  artifactPath: string;
  stalledRecoveryIssueId: string;
  stalledRunId: string;
  resultStatus: string;
  idempotencyKey: string;
};

export type MissionOwnerSupervisionResult = {
  missionId: string;
  oversightIssueId: string | null;
  findings: string[];
  recommendations: MissionOwnerSupervisionRecommendation[];
  appliedActions: MissionOwnerSupervisionAppliedAction[];
  ownerActionExplanations: MissionOwnerActionExplanation[];
  commented: boolean;
};

export type ActiveMissionOwnerSupervisionResult = {
  companyId?: string;
  missionIds: string[];
  missions: MissionOwnerSupervisionResult[];
};


/** unknown 값을 MissionOwnerDecisionWakeupDispatchStatus로 정규화. */
export function normalizeMissionOwnerDecisionWakeupDispatchResult(value: unknown): MissionOwnerDecisionWakeupDispatchStatus {
  if (!isRecord(value)) return "dispatched";
  switch (value.status) {
    case "not_requested":
    case "dispatched":
    case "workflow_already_dispatched":
    case "skipped_no_assignee":
    case "failed":
      return value.status;
    default:
      return "dispatched";
  }
}
