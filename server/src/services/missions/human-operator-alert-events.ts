import type { ExtractedMissionOwnerDecision } from "./mission-owner-recovery-events.js";
import { publishLiveEvent } from "../live-events.js";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

export const HUMAN_OPERATOR_REQUEST_ACTION = "mission.owner.human_input_requested";

type OwnerDecisionIssue = {
  id: string;
  companyId: string;
  missionId: string | null;
  originKind: string | null;
  originId?: string | null;
  title?: string | null;
  identifier?: string | null;
};

type OwnerDecisionComment = {
  id: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
};

export type HumanOperatorStructuredDecision = ExtractedMissionOwnerDecision;

export type HumanOperatorDecisionRecordMetadata = {
  eventId: string;
  commentId?: string | null;
  authorAgentId: string;
  decision?: ExtractedMissionOwnerDecision;
};

export type HumanOperatorRequestPayload = {
  missionId: string;
  issueId: string;
  sourceIssueId?: string;
  commentId?: string;
  decisionEventId?: string;
  decision: "request_input" | "escalate";
  issueTitle?: string;
  issueIdentifier?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
  actorType?: "agent" | "user" | "system";
  actorId?: string;
};

export type HumanOperatorRequestInput = {
  issue: OwnerDecisionIssue;
  // Legacy comments are accepted only to keep existing callers compiling. They are
  // never parsed or used as decision authority.
  comment?: OwnerDecisionComment;
  decision?: HumanOperatorStructuredDecision;
  // Metadata from the structured ledger record; it never supplies a decision.
  record?: HumanOperatorDecisionRecordMetadata;
};

export function buildHumanOperatorRequestPayload(
  input: HumanOperatorRequestInput,
): HumanOperatorRequestPayload | null {
  if (!input.issue.missionId) return null;
  if (input.issue.originKind !== "mission_main_executor_unblock") return null;

  const record = input.record;
  const decision = input.decision ?? record?.decision;
  if (decision?.decision !== "request_input" && decision?.decision !== "escalate") return null;
  if (!record?.eventId || !record.authorAgentId) return null;

  const commentId = record.commentId ?? undefined;
  const decisionEventId = record.eventId;

  return {
    missionId: input.issue.missionId,
    issueId: input.issue.id,
    ...(input.issue.originId ? { sourceIssueId: input.issue.originId } : {}),
    ...(commentId ? { commentId } : {}),
    ...(decisionEventId ? { decisionEventId } : {}),
    decision: decision.decision,
    ...(input.issue.title ? { issueTitle: input.issue.title } : {}),
    ...(input.issue.identifier ? { issueIdentifier: input.issue.identifier } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.nextAction ? { nextAction: decision.nextAction } : {}),
    ...(decision.evidence ? { evidence: decision.evidence } : {}),
    actorType: "agent",
    actorId: record.authorAgentId,
  };
}

function activityDetails(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// [common primitive] 이미 구성된 payload 로 tx-safe materialize. owner 구조 결정(agent) 와 terminal
//   system report(system) 양쪽이 같은 dedupe(by decisionEventId)+insert 경로를 사용한다.
export async function materializeHumanOperatorRequestPayload(
  db: Db,
  payload: HumanOperatorRequestPayload,
  companyId: string,
): Promise<{ payload: HumanOperatorRequestPayload; inserted: boolean }> {
  if (!payload.issueId || !payload.decisionEventId) return { payload, inserted: false };

  const existingRows = await db
    .select({ id: activityLog.id, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, payload.issueId),
    ));
  const alreadyRecorded = existingRows.some((row) => (
    activityDetails(row.details)?.decisionEventId === payload.decisionEventId
  ));
  if (alreadyRecorded) return { payload, inserted: false };

  await db.insert(activityLog).values({
    companyId,
    actorType: payload.actorType ?? "system",
    actorId: payload.actorId ?? payload.actorType ?? "system",
    action: HUMAN_OPERATOR_REQUEST_ACTION,
    entityType: "issue",
    entityId: payload.issueId,
    agentId: payload.actorType === "agent" ? payload.actorId ?? null : null,
    details: payload,
  });
  return { payload, inserted: true };
}

// [finding 5] tx-safe materialize for owner structured decisions. payload 는 fail-closed builder 로 구성.
//   terminal system report 는 materializeHumanOperatorRequestPayload 를 system payload 와 직접 호출.
export async function materializeHumanOperatorRequestEvent(db: Db, input: HumanOperatorRequestInput): Promise<{ payload: HumanOperatorRequestPayload | null; inserted: boolean }> {
  const payload = buildHumanOperatorRequestPayload(input);
  if (!payload || !payload.decisionEventId) return { payload: null, inserted: false };
  const result = await materializeHumanOperatorRequestPayload(db, payload, input.issue.companyId);
  return { payload: result.payload, inserted: result.inserted };
}

// [finding 5] post-commit publish step. materialize 가 실제로 insert 한 경우에만 호출한다.
export function publishHumanOperatorRequestEvent(companyId: string, payload: HumanOperatorRequestPayload): void {
  publishLiveEvent({
    companyId,
    type: "mission.human_input_requested",
    payload,
  });
}

export async function recordHumanOperatorRequestEvent(
  db: Db,
  input: HumanOperatorRequestInput,
): Promise<HumanOperatorRequestPayload | null> {
  const { payload, inserted } = await materializeHumanOperatorRequestEvent(db, input);
  if (payload && inserted) publishHumanOperatorRequestEvent(input.issue.companyId, payload);
  return payload;
}
