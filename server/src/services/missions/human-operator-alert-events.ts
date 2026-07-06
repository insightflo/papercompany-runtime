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

type HumanOperatorDecisionSignal = {
  decision: "request_input" | "escalate";
  reason?: string;
  nextAction?: string;
  evidence?: string;
};

function firstLineAfterLabel(text: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escapedLabel}\\s*[:：]\\s*([^\\n]+)`, "i").exec(text);
  return match?.[1]?.trim();
}

function extractFallbackHumanOperatorSignal(text: string): HumanOperatorDecisionSignal | null {
  const normalized = text.toLowerCase();
  const mentionsHumanOperator = /\bhuman[-/\s]?operator\b/.test(normalized) ||
    /\bhuman\/operator\b/.test(normalized);
  if (!mentionsHumanOperator) return null;

  const negatesHandoff = /\b(no|not|without)\s+(human[-/\s]?operator|human\/operator|operator input)\b/.test(normalized) ||
    /human[-/\s]?operator\s+(input\s+)?(is\s+)?not\s+(needed|required)/.test(normalized) ||
    /필요\s*없/.test(text);
  if (negatesHandoff) return null;

  const hasHandoffSignal = /\breportsto\b/.test(normalized) ||
    /\b(request|requires?|needed|input|handoff|authority|receiver|escalat(?:e|ed|ion))\b/.test(normalized) ||
    /운영자|상위\s*오너|결정해야|필요|권한/.test(text);
  if (!hasHandoffSignal) return null;

  const nextAction = firstLineAfterLabel(text, "Next action") ?? firstLineAfterLabel(text, "다음 조치");
  const evidence = firstLineAfterLabel(text, "Evidence") ?? firstLineAfterLabel(text, "누락 증거");
  return {
    decision: normalized.includes("escalate") ? "escalate" : "request_input",
    reason: "Owner action comment names human operator as the handoff target.",
    ...(nextAction ? { nextAction } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function buildHumanOperatorRequestPayload(input: {
  issue: OwnerDecisionIssue;
  comment: OwnerDecisionComment;
}): HumanOperatorRequestPayload | null {
  if (!input.issue.missionId) return null;
  if (input.issue.originKind !== "mission_main_executor_unblock") return null;

  const decision = extractMissionOwnerDecisionFromText(input.comment.body);
  const decisionSignal: HumanOperatorDecisionSignal | null =
    decision?.decision === "request_input" || decision?.decision === "escalate"
      ? {
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.nextAction ? { nextAction: decision.nextAction } : {}),
          ...(decision.evidence ? { evidence: decision.evidence } : {}),
        }
      : decision === null
        ? extractFallbackHumanOperatorSignal(input.comment.body)
        : null;
  if (!decisionSignal) return null;

  const actorType = input.comment.authorAgentId ? "agent" : input.comment.authorUserId ? "user" : "system";
  const actorId = input.comment.authorAgentId ?? input.comment.authorUserId ?? undefined;

  return {
    missionId: input.issue.missionId,
    issueId: input.issue.id,
    ...(input.issue.originId ? { sourceIssueId: input.issue.originId } : {}),
    commentId: input.comment.id,
    decision: decisionSignal.decision,
    ...(input.issue.title ? { issueTitle: input.issue.title } : {}),
    ...(input.issue.identifier ? { issueIdentifier: input.issue.identifier } : {}),
    ...(decisionSignal.reason ? { reason: decisionSignal.reason } : {}),
    ...(decisionSignal.nextAction ? { nextAction: decisionSignal.nextAction } : {}),
    ...(decisionSignal.evidence ? { evidence: decisionSignal.evidence } : {}),
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
