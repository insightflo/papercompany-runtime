// server/src/services/missions/mission-owner-recovery-ledger.ts
//
// [목적] mission-owner recovery 결정의 구조적 권위 기록. 자연어 comment parsing 을 실행 권위에서
//   제거하고, workflow_transition_events 에 company/mission/owner-action/source-issue scoped 구조 이벤트로
//   영속화한다. Supervision/cap-override/QA-cap-oversight/heartbeat/human-report consumer 는 오직 이
//   reader 를 통해 결정을 읽는다. 표시용 comment 는 dual-write 될 수 있으나 권위로 read-back 금지.
// [외부 연결] writer: agent API(routes/mission-owner-recovery-agent-api), reader: supervision/cap-override/
//   QA-cap/heartbeat/human-report.
// [수정시 주의] 스키마 변경 없음(workflow_transition_events 재사용). row 는 고정 source marker
//   (reason/reasonCode=owner_recovery_api) 로 식별된다. authorship 은 payload+heartbeat run(companyId+issueId
//   정합) 로 검증한다.
import { and, eq } from "drizzle-orm";
import { workflowTransitionEvents } from "@paperclipai/db";
import {
  buildMissionOwnerDecisionIdempotencyKey,
  MISSION_OWNER_DECISION_EVENT_TYPE,
  MISSION_OWNER_DECISION_SOURCE,
  MISSION_OWNER_RECOVERY_LAYER,
  type MissionOwnerDecisionSubmission,
  type MissionOwnerRecoveryLedgerDb,
  type RecordedMissionOwnerDecision,
} from "./mission-owner-decision-contract.js";

export {
  buildMissionOwnerDecisionIdempotencyKey,
  MISSION_OWNER_DECISION_EVENT_TYPE,
  MISSION_OWNER_DECISION_SOURCE,
  MISSION_OWNER_RECOVERY_LAYER,
  normalizeSubmission as parseMissionOwnerDecisionPayload,
  type MissionOwnerDecisionSubmission,
  type MissionOwnerDecisionRecord,
  type MissionOwnerRecoveryLedgerDb,
  type RecordedMissionOwnerDecision,
} from "./mission-owner-decision-contract.js";
export {
  loadLatestMissionOwnerDecision,
  loadMissionOwnerDecisions,
  validateOwnerDecisionEvent,
  hasStructuredSourceRecoveryDecision,
} from "./mission-owner-decision-read.js";

type OwnerActionIssue = {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
};

export async function recordMissionOwnerDecision(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly issue: OwnerActionIssue;
  readonly submission: MissionOwnerDecisionSubmission;
  readonly sourceIssueId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly commentId?: string | null;
}): Promise<RecordedMissionOwnerDecision> {
  const sourceIssueId = input.sourceIssueId ?? null;
  const payload = {
    kind: MISSION_OWNER_DECISION_EVENT_TYPE,
    source: MISSION_OWNER_DECISION_SOURCE,
    ownerActionIssueId: input.issue.id,
    sourceIssueId,
    commentId: input.commentId ?? null,
    decision: input.submission.decision,
    ...(input.submission.recoveryTarget ? { recoveryTarget: input.submission.recoveryTarget } : {}),
    ...(input.submission.sourceIssueRef ? { sourceIssueRef: input.submission.sourceIssueRef } : {}),
    ...(input.submission.reworkTargetRef ? { reworkTargetRef: input.submission.reworkTargetRef } : {}),
    ...(input.submission.targetAgentId ? { targetAgentId: input.submission.targetAgentId } : {}),
    ...(input.submission.reason ? { reason: input.submission.reason } : {}),
    ...(input.submission.nextAction ? { nextAction: input.submission.nextAction } : {}),
    ...(input.submission.evidence ? { evidence: input.submission.evidence } : {}),
  };
  const idempotencyKey = buildMissionOwnerDecisionIdempotencyKey({
    companyId: input.issue.companyId,
    ownerActionIssueId: input.issue.id,
    sourceIssueId,
    submission: input.submission,
    heartbeatRunId: input.heartbeatRunId,
  });
  const inserted = await input.db.insert(workflowTransitionEvents).values({
    companyId: input.issue.companyId,
    missionId: input.issue.missionId ?? null,
    issueId: input.issue.id,
    heartbeatRunId: input.heartbeatRunId ?? null,
    eventType: MISSION_OWNER_DECISION_EVENT_TYPE,
    layer: MISSION_OWNER_RECOVERY_LAYER,
    decision: input.submission.decision,
    // [immutable marker] user free-text reason 은 payload 에만; row.reason/reasonCode 는 고정 source.
    reason: MISSION_OWNER_DECISION_SOURCE,
    reasonCode: MISSION_OWNER_DECISION_SOURCE,
    idempotencyKey,
    payload,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt });

  // [exact event identity] 동일 run idempotency 충돌 시 insert 가 no-op 이면 같은 (company, idempotencyKey)
  //   row 를 안전하게 load 하여 authoritative eventId 를 반환한다.
  if (inserted.length > 0) {
    const row = inserted[0]!;
    return { eventId: row.id, createdAt: row.createdAt, submission: input.submission };
  }
  const [existing] = await input.db
    .select({ id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.issue.companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
      eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
      eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
      eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
      eq(workflowTransitionEvents.issueId, input.issue.id),
    ))
    .limit(1);
  if (!existing) {
    throw new Error("mission-owner-recovery-ledger: failed to resolve authoritative decision event after insert");
  }
  return { eventId: existing.id, createdAt: existing.createdAt, submission: input.submission };
}
