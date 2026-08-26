import type { Db } from "@paperclipai/db";
import { activityLog, issues, missions } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { GovernanceThreadEvent } from "./governance-thread.js";
import { HUMAN_OPERATOR_REQUEST_ACTION, type HumanOperatorRequestPayload } from "./human-operator-alert-events.js";
import { formatOperatorDecisionSummary } from "./operator-card-summary.js";

const DEFAULT_REQUEST_LIMIT = 50;
const MAX_CANDIDATE_REQUESTS = 250;
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
  if (typeof record.decisionEventId !== "string" || !record.decisionEventId) return null;
  return record as HumanOperatorRequestPayload;
}

function compactSummary(payload: HumanOperatorRequestPayload, missionTitle: string): string {
  // [display-only] 구조화된 payload 필드로 한국어 운영자 카드 요약을 만든다. rule 8: 표시 전용.
  return formatOperatorDecisionSummary({
    decision: payload.decision,
    missionTitle,
    issueTitle: payload.issueTitle,
    issueIdentifier: payload.issueIdentifier,
    issueId: payload.issueId,
    reason: payload.reason,
    nextAction: payload.nextAction,
    evidence: payload.evidence,
  });
}

function isOpenIssueStatus(status: string): boolean {
  return (OPEN_ISSUE_STATUSES as readonly string[]).includes(status);
}

type HumanOperatorActivityRow = {
  activityId: string;
  activityDetails: unknown;
  activityCreatedAt: Date;
  issueId: string;
  issueTitle: string;
  issueStatus: string;
  missionId: string;
  missionTitle: string;
  missionStatus: string;
};

async function loadSourceIssueRows(
  db: Db,
  companyId: string,
  sourceIssueIds: readonly string[],
): Promise<Map<string, { id: string; title: string; status: string; missionId: string | null }>> {
  if (sourceIssueIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      title: issues.title,
      status: issues.status,
      missionId: issues.missionId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...sourceIssueIds])));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function listCompanyHumanOperatorRequests(
  db: Db,
  input: {
    companyId: string;
    limit?: number;
  },
): Promise<HumanOperatorRequest[]> {
  const requestLimit = input.limit ?? DEFAULT_REQUEST_LIMIT;
  const candidateLimit = Math.min(requestLimit * 5, MAX_CANDIDATE_REQUESTS);
  const rows: HumanOperatorActivityRow[] = await db
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
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(candidateLimit);

  const parsed = rows
    .map((row) => ({ row, payload: asPayload(row.activityDetails) }))
    .filter((entry): entry is { row: HumanOperatorActivityRow; payload: HumanOperatorRequestPayload } =>
      Boolean(entry.payload),
    );

  const sourceIssueIds = Array.from(new Set(
    parsed.map((entry) => entry.payload.sourceIssueId ?? "").filter((value) => value.length > 0),
  ));
  const sourceIssuesById = await loadSourceIssueRows(db, input.companyId, sourceIssueIds);

  const requests: HumanOperatorRequest[] = [];
  for (const { row, payload } of parsed) {
    const ownerOpen = isOpenIssueStatus(row.issueStatus);
    const sourceRow = payload.sourceIssueId ? sourceIssuesById.get(payload.sourceIssueId) ?? null : null;
    const sourceOpen = Boolean(
      sourceRow
        && sourceRow.missionId === row.missionId
        && isOpenIssueStatus(sourceRow.status),
    );
    if (!ownerOpen && !sourceOpen) continue;

    const targetIssueId = sourceOpen && sourceRow ? sourceRow.id : row.issueId;
    const title = payload.decision === "request_input" ? "Human/operator input requested" : "Mission blocker escalated";
    const timestamp = row.activityCreatedAt.toISOString();
    const actor = payload.actorType
      ? { type: payload.actorType, ...(payload.actorId ? { id: payload.actorId } : {}) }
      : undefined;
    const evidenceRefs = payload.commentId
      ? [{ type: "comment" as const, ref: payload.commentId, label: "mission owner decision" }]
      : [{ type: "log" as const, ref: payload.decisionEventId!, label: "mission owner decision" }];
    const event: GovernanceThreadEvent = {
      id: `owner_diagnosis:activity_log:${row.activityId}`,
      companyId: input.companyId,
      scope: { missionId: row.missionId, issueId: targetIssueId },
      sourceRef: { type: "activity_log", id: row.activityId, table: "activity_log" },
      eventType: "owner_diagnosis",
      title,
      summary: compactSummary(payload, row.missionTitle),
      timestamp,
      severity: payload.decision === "escalate" ? "blocked" : "attention",
      ...(actor ? { actor } : {}),
      evidenceRefs,
      suggestedResumeTarget: { action: "request_human_input", issueId: targetIssueId },
      rawAvailable: true,
    };
    requests.push({
      id: `${row.missionId}:${row.activityId}`,
      companyId: input.companyId,
      missionId: row.missionId,
      missionTitle: row.missionTitle,
      missionStatus: row.missionStatus,
      issueId: targetIssueId,
      title,
      summary: event.summary,
      timestamp,
      severity: event.severity,
      event,
    });
    if (requests.length >= requestLimit) break;
  }

  return requests;
}
