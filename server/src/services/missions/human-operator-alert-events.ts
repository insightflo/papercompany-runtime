import { extractMissionOwnerDecisionFromText } from "./mission-owner-recovery-events.js";
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

export type HumanOperatorRequestPayload = {
  missionId: string;
  issueId: string;
  sourceIssueId?: string;
  commentId: string;
  decision: "request_input" | "escalate";
  issueTitle?: string;
  issueIdentifier?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
  actorType: "agent" | "user" | "system";
  actorId?: string;
};

export function buildHumanOperatorRequestPayload(input: {
  issue: OwnerDecisionIssue;
  comment: OwnerDecisionComment;
}): HumanOperatorRequestPayload | null {
  if (!input.issue.missionId) return null;
  if (input.issue.originKind !== "mission_main_executor_unblock") return null;

  const decision = extractMissionOwnerDecisionFromText(input.comment.body);
  if (decision?.decision !== "request_input" && decision?.decision !== "escalate") return null;

  const actorType = input.comment.authorAgentId ? "agent" : input.comment.authorUserId ? "user" : "system";
  const actorId = input.comment.authorAgentId ?? input.comment.authorUserId ?? undefined;

  return {
    missionId: input.issue.missionId,
    issueId: input.issue.id,
    ...(input.issue.originId ? { sourceIssueId: input.issue.originId } : {}),
    commentId: input.comment.id,
    decision: decision.decision,
    ...(input.issue.title ? { issueTitle: input.issue.title } : {}),
    ...(input.issue.identifier ? { issueIdentifier: input.issue.identifier } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.nextAction ? { nextAction: decision.nextAction } : {}),
    ...(decision.evidence ? { evidence: decision.evidence } : {}),
    actorType,
    ...(actorId ? { actorId } : {}),
  };
}

function activityDetails(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function recordHumanOperatorRequestEvent(db: Db, input: {
  issue: OwnerDecisionIssue;
  comment: OwnerDecisionComment;
}): Promise<HumanOperatorRequestPayload | null> {
  const payload = buildHumanOperatorRequestPayload(input);
  if (!payload) return null;

  const existingRows = await db
    .select({ id: activityLog.id, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.issue.companyId),
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issue.id),
    ));
  const alreadyRecorded = existingRows.some((row) => activityDetails(row.details)?.commentId === input.comment.id);
  if (alreadyRecorded) return payload;

  await db.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: payload.actorType,
    actorId: payload.actorId ?? payload.actorType,
    action: HUMAN_OPERATOR_REQUEST_ACTION,
    entityType: "issue",
    entityId: input.issue.id,
    agentId: payload.actorType === "agent" ? payload.actorId ?? null : null,
    details: payload,
  });

  publishLiveEvent({
    companyId: input.issue.companyId,
    type: "mission.human_input_requested",
    payload,
  });
  return payload;
}
