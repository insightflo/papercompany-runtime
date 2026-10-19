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
  /** [표시 통합 2026-10-18] 같은 (missionId, issueId, decision 종류) 반복 행 수. 표시 전용 값이며
 *  없는(예전 직렬화) 행은 소비자가 1로 해석한다. 활동 로그·집계에는 영향이 없다. */
  count: number;
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

  // [표시 통합 2026-10-18] 같은 (missionId, issueId, decision 종류)의 반복 행을 하나로 묶는다 —
  // 같은 건이 시차를 두고 5행씩 쌓이는 라이브 문제 대응. 대표 행은 최신 타임스탬프 행(후보가
  // createdAt desc 로 정렬돼 있어 그룹 첫 등장 행)이고 count 로 총 행수를 노출한다. 표시 전용
  // 변경이다: 행 삭제·활동 로그·집계 로직은 건드리지 않고, 유형/이슈가 다른 행은 별도 그룹으로
  // 유지된다(과소 병합으로 실제로 봐야 할 건을 숨기지 않는다).
  const grouped = new Map<string, { request: HumanOperatorRequest; count: number }>();
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
    const groupKey = `${row.missionId}|${targetIssueId}|${payload.decision}`;
    const existingGroup = grouped.get(groupKey);
    if (existingGroup) {
      existingGroup.count += 1;
      continue;
    }
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
    grouped.set(groupKey, {
      request: {
        id: `${row.missionId}:${row.activityId}`,
        companyId: input.companyId,
        missionId: row.missionId,
        missionTitle: row.missionTitle,
        missionStatus: row.missionStatus,
        issueId: targetIssueId,
        title,
        summary: event.summary,
        timestamp,
        count: 1,
        severity: event.severity,
        event,
      },
      count: 1,
    });
  }

  // 삽입 순서 = 그룹 최신 타임스탬프 내림차순(후보 정렬 상속) — 상위 requestLimit 개 그룹만 반환한다.
  return Array.from(grouped.values())
    .slice(0, requestLimit)
    .map((group) => ({ ...group.request, count: group.count }));
}
