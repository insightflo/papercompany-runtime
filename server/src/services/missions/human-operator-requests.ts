import type { Db } from "@paperclipai/db";
import { activityLog, issues, missions } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { GovernanceThreadEvent } from "./governance-thread.js";
import { HUMAN_OPERATOR_REQUEST_ACTION, type HumanOperatorRequestPayload } from "./human-operator-alert-events.js";

const DEFAULT_REQUEST_LIMIT = 50;
const OPEN_MISSION_STATUSES = ["planning", "active", "paused"] as const;
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

export type HumanOperatorRequest = {
  id: string;
  companyId: string;
  missionId: string;
  missionTitle: string;
  missionStatus: string;
  issueId?: string;
  title: string;
  summary: string;
  timestamp: string;
  severity?: GovernanceThreadEvent["severity"];
  event: GovernanceThreadEvent;
};

function asPayload(value: unknown): HumanOperatorRequestPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.decision !== "request_input" && record.decision !== "escalate") return null;
  if (typeof record.missionId !== "string" || typeof record.issueId !== "string") return null;
  if (typeof record.commentId !== "string") return null;
  return record as HumanOperatorRequestPayload;
}

function compactSummary(payload: HumanOperatorRequestPayload): string {
  return [
    payload.decision === "request_input" ? "Human/operator input requested" : "Mission blocker escalated",
    payload.reason,
    payload.nextAction,
    payload.evidence,
  ].filter((value): value is string => Boolean(value?.trim())).join(": ").slice(0, 280);
}

export async function listCompanyHumanOperatorRequests(
  db: Db,
  input: {
    companyId: string;
    limit?: number;
  },
): Promise<HumanOperatorRequest[]> {
  const requestLimit = input.limit ?? DEFAULT_REQUEST_LIMIT;
  const rows = await db
    .select({
      activityId: activityLog.id,
      activityDetails: activityLog.details,
      activityCreatedAt: activityLog.createdAt,
      issueId: issues.id,
      issueTitle: issues.title,
      issueStatus: issues.status,
      missionId: missions.id,
      missionTitle: missions.title,
      missionStatus: missions.status,
    })
    .from(activityLog)
    .innerJoin(issues, sql`${activityLog.entityId}::uuid = ${issues.id}`)
    .innerJoin(missions, eq(issues.missionId, missions.id))
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
      eq(activityLog.entityType, "issue"),
      inArray(missions.status, [...OPEN_MISSION_STATUSES]),
      inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(requestLimit);

  const requests: HumanOperatorRequest[] = [];
  for (const row of rows) {
    const payload = asPayload(row.activityDetails);
    if (!payload) continue;
    const title = payload.decision === "request_input" ? "Human/operator input requested" : "Mission blocker escalated";
    const timestamp = row.activityCreatedAt.toISOString();
    const event: GovernanceThreadEvent = {
      id: `owner_diagnosis:activity_log:${row.activityId}`,
      companyId: input.companyId,
      scope: { missionId: row.missionId, issueId: row.issueId },
      sourceRef: { type: "activity_log", id: row.activityId, table: "activity_log" },
      eventType: "owner_diagnosis",
      title,
      summary: compactSummary(payload),
      timestamp,
      severity: payload.decision === "escalate" ? "blocked" : "attention",
      actor: { type: payload.actorType, ...(payload.actorId ? { id: payload.actorId } : {}) },
      evidenceRefs: [{ type: "comment", ref: payload.commentId, label: "mission owner decision" }],
      suggestedResumeTarget: { action: "request_human_input", issueId: row.issueId },
      rawAvailable: true,
    };
    requests.push({
      id: `${row.missionId}:${row.activityId}`,
      companyId: input.companyId,
      missionId: row.missionId,
      missionTitle: row.missionTitle,
      missionStatus: row.missionStatus,
      issueId: row.issueId,
      title,
      summary: event.summary,
      timestamp,
      severity: event.severity,
      event,
    });
  }

  return requests;
}
