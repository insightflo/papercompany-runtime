// Structured owner decision writer. Legacy identity remains unchanged; an explicit human
// request key gets its own fixed-size locator so A→B→A cannot reuse A's original event.
import { and, eq } from "drizzle-orm";
import { workflowTransitionEvents } from "@paperclipai/db";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { ownerHumanRequestSchema } from "@paperclipai/shared/validators/owner-human-request";
import { conflict } from "../../errors.js";
import { ownerHumanLifetimeKey, sameOwnerHumanValue } from "./owner-human-request-contract.js";
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

// Immutable CAS provenance for an explicit request, using an existing correlation column.
// The original payload's strict contract is unchanged. Raw request-key equality is checked
// against the lifetime payload by the state writer; a digest alone never proves identity.
export const ownerHumanExpectedCorrelation = (expected: string | null) =>
  `owner-human-expected:v1:${expected ?? "none"}`;

type OwnerActionIssue = {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
};

export async function recordMissionOwnerDecision(input: {
  readonly db: MissionOwnerRecoveryLedgerDb;
  readonly issue: OwnerActionIssue;
  readonly submission: MissionOwnerDecisionSubmission & {
    readonly recommendedOptionId?: string;
    readonly recommendationReason?: string;
  };
  readonly sourceIssueId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly commentId?: string | null;
  readonly humanRequest?: NonNullable<MissionOwnerDecisionSubmit["humanRequest"]>;
}): Promise<RecordedMissionOwnerDecision> {
  const human = input.humanRequest;
  if (human && (!ownerHumanRequestSchema.safeParse(human).success
    || !["request_input", "escalate"].includes(input.submission.decision))) {
    throw conflict("Invalid owner human request identity", { reason: "owner_human_request_invalid" });
  }
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
    ...(input.submission.recommendedOptionId
      ? { recommendedOptionId: input.submission.recommendedOptionId } : {}),
    ...(input.submission.recommendationReason
      ? { recommendationReason: input.submission.recommendationReason } : {}),
  };
  const idempotencyKey = human
    ? `mission-owner-decision:${ownerHumanLifetimeKey(human.requestKey)}`
    : buildMissionOwnerDecisionIdempotencyKey({
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
    reason: MISSION_OWNER_DECISION_SOURCE,
    reasonCode: MISSION_OWNER_DECISION_SOURCE,
    ...(human ? { correlationId: ownerHumanExpectedCorrelation(human.expectedCurrentLifetimeId) } : {}),
    idempotencyKey,
    payload,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id, createdAt: workflowTransitionEvents.createdAt });
  if (inserted.length > 0) {
    const row = inserted[0]!;
    return { eventId: row.id, createdAt: row.createdAt, submission: input.submission };
  }
  const [existing] = await input.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.issue.companyId),
    eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
    eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
    eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
    eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
    eq(workflowTransitionEvents.issueId, input.issue.id),
  )).limit(1);
  if (!existing) {
    throw new Error("mission-owner-recovery-ledger: failed to resolve authoritative decision event after insert");
  }
  if (human && (existing.missionId !== input.issue.missionId
    || existing.reasonCode !== MISSION_OWNER_DECISION_SOURCE
    || existing.correlationId !== ownerHumanExpectedCorrelation(human.expectedCurrentLifetimeId)
    || !sameOwnerHumanValue(existing.payload, payload))) {
    throw conflict("Owner human request key conflicts with its original decision", {
      reason: "owner_human_request_key_conflict",
    });
  }
  return { eventId: existing.id, createdAt: existing.createdAt, submission: input.submission };
}
