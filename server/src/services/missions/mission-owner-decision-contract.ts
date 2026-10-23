// mission-owner recovery 결정의 공유 타입·정규화·식별 키 계약.
import { createHash } from "node:crypto";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { ExtractedMissionOwnerDecision, MissionOwnerDecisionOption, OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "./mission-owner-recovery-events.js";

export const MISSION_OWNER_RECOVERY_LAYER = "mission_owner_recovery";
export const MISSION_OWNER_DECISION_EVENT_TYPE = "mission_owner_decision";
// [immutable source marker] 구조 제출(row)을 식별하는 고정 reason/reasonCode. user free-text reason
//   은 payload 에만 저장하고 workflowTransitionEvents.reason 열에 넣지 않는다. 모든 reader 가 이
//   marker 를 필터링하여 legacy/parser-derived row 가 무시되도록 한다.
export const MISSION_OWNER_DECISION_SOURCE = "owner_recovery_api";

export type MissionOwnerDecisionSubmission = {
  readonly decision: MissionOwnerDecisionOption;
  readonly recoveryTarget?: OwnerRecoveryTarget;
  readonly sourceIssueRef?: string;
  readonly reworkTargetRef?: string;
  readonly targetAgentId?: string;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
};

export type MissionOwnerDecisionRecord = {
  readonly eventId: string;
  readonly createdAt: Date;
  readonly ownerActionIssueId: string;
  readonly missionId: string | null;
  readonly sourceIssueId: string | null;
  readonly heartbeatRunId: string | null;
  readonly authorAgentId: string;
  readonly commentId: string | null;
  readonly decision: ExtractedMissionOwnerDecision;
};

export type MissionOwnerRecoveryLedgerDb = Pick<Db, "select" | "insert">;

export type RecordedMissionOwnerDecision = {
  readonly eventId: string;
  readonly createdAt: Date;
  readonly submission: MissionOwnerDecisionSubmission;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeSubmission(raw: {
  decision: string;
  recoveryTarget?: unknown;
  sourceIssueRef?: string | null;
  reworkTargetRef?: string | null;
  targetAgentId?: string | null;
  reason?: string | null;
  nextAction?: string | null;
  evidence?: string | null;
}): MissionOwnerDecisionSubmission | null {
  if (!MISSION_OWNER_DECISION_OPTIONS.includes(raw.decision as MissionOwnerDecisionOption)) return null;
  const target = missionOwnerDecisionSubmitSchema.safeParse({ decision: "no_action_waiting", recoveryTarget: raw.recoveryTarget });
  if (!target.success) return null;
  const trimmed = (value: string | null | undefined): string | undefined => {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized ? normalized : undefined;
  };
  const targetAgentId = trimmed(raw.targetAgentId);
  if (targetAgentId && !UUID_RE.test(targetAgentId)) return null;
  return {
    decision: raw.decision as MissionOwnerDecisionOption,
    ...(target.data.recoveryTarget ? { recoveryTarget: target.data.recoveryTarget } : {}),
    ...(trimmed(raw.sourceIssueRef) ? { sourceIssueRef: trimmed(raw.sourceIssueRef) } : {}),
    ...(trimmed(raw.reworkTargetRef) ? { reworkTargetRef: trimmed(raw.reworkTargetRef) } : {}),
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(trimmed(raw.reason) ? { reason: trimmed(raw.reason) } : {}),
    ...(trimmed(raw.nextAction) ? { nextAction: trimmed(raw.nextAction) } : {}),
    ...(trimmed(raw.evidence) ? { evidence: trimmed(raw.evidence) } : {}),
  };
}

export function submissionToDecision(submission: MissionOwnerDecisionSubmission): ExtractedMissionOwnerDecision {
  const decision: ExtractedMissionOwnerDecision = { decision: submission.decision };
  if (submission.recoveryTarget) decision.recoveryTarget = submission.recoveryTarget;
  if (submission.sourceIssueRef) decision.sourceIssueRef = submission.sourceIssueRef;
  if (submission.reworkTargetRef) decision.reworkTargetRef = submission.reworkTargetRef;
  if (submission.targetAgentId) decision.targetAgentId = submission.targetAgentId;
  if (submission.reason) decision.reason = submission.reason;
  if (submission.nextAction) decision.nextAction = submission.nextAction;
  if (submission.evidence) decision.evidence = submission.evidence;
  return decision;
}

function decisionPayloadFingerprint(submission: MissionOwnerDecisionSubmission): string {
  return createHash("sha256").update(JSON.stringify([
    submission.decision,
    submission.sourceIssueRef ?? null,
    submission.reworkTargetRef ?? null,
    submission.targetAgentId ?? null,
    submission.reason ?? null,
    submission.nextAction ?? null,
    submission.evidence ?? null,
    ...(submission.recoveryTarget ? [submission.recoveryTarget] : []),
  ])).digest("hex").slice(0, 24);
}

export function buildMissionOwnerDecisionIdempotencyKey(input: {
  readonly companyId: string;
  readonly ownerActionIssueId: string;
  readonly sourceIssueId: string | null;
  readonly submission: MissionOwnerDecisionSubmission;
  readonly heartbeatRunId?: string | null;
}): string {
  const runSegment = typeof input.heartbeatRunId === "string" && input.heartbeatRunId
    ? `run:${input.heartbeatRunId}`
    : "run:none";
  return `mission-owner-decision:${input.companyId}:${input.ownerActionIssueId}:${input.sourceIssueId ?? "no-source"}:${runSegment}:payload:${decisionPayloadFingerprint(input.submission)}`;
}
