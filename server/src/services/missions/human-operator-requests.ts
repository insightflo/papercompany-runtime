import type { Db } from "@paperclipai/db";
import { activityLog, issues, missions } from "@paperclipai/db";
import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { GovernanceThreadEvent } from "./governance-thread.js";
import { HUMAN_OPERATOR_REQUEST_ACTION, type HumanOperatorRequestPayload } from "./human-operator-alert-events.js";
import { formatOperatorDecisionSummary } from "./operator-card-summary.js";
import { projectHumanRequestStates, type HumanOperatorRequestCandidate } from "./human-request-state-projection.js";

const DEFAULT_REQUEST_LIMIT = 50;
const MAX_CANDIDATE_REQUESTS = 250;
const OPEN_MISSION_STATUSES = ["planning", "active", "paused"] as const;
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  count: number;
  severity?: GovernanceThreadEvent["severity"];
  event: GovernanceThreadEvent;
  requestState?: HumanOperatorRequestStateV1;
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
  return formatOperatorDecisionSummary({
    decision: payload.decision, missionTitle, issueTitle: payload.issueTitle,
    issueIdentifier: payload.issueIdentifier, issueId: payload.issueId,
    reason: payload.reason, nextAction: payload.nextAction, evidence: payload.evidence,
  });
}

function isOpen(status: string): boolean {
  return (OPEN_ISSUE_STATUSES as readonly string[]).includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceConsistent(
  payload: HumanOperatorRequestPayload,
  owner: { companyId: string; missionId: string | null; originKind: string; originId: string | null },
  source: { companyId: string; missionId: string | null } | undefined,
  companyId: string,
): boolean {
  if (payload.sourceIssueId === undefined) return true;
  return typeof payload.sourceIssueId === "string"
    && UUID.test(payload.sourceIssueId)
    && source?.companyId === companyId
    && source.missionId === owner.missionId
    && (owner.originKind !== "mission_main_executor_unblock" || owner.originId === payload.sourceIssueId);
}

export async function listCompanyHumanOperatorRequests(
  db: Db,
  input: { companyId: string; limit?: number },
): Promise<HumanOperatorRequest[]> {
  const requestLimit = input.limit ?? DEFAULT_REQUEST_LIMIT;
  const candidateLimit = Math.min(requestLimit * 5, MAX_CANDIDATE_REQUESTS);
  return db.transaction(async (tx) => {
    const now = new Date();
    const activityRows = await tx.select({
      activityId: activityLog.id,
      companyId: activityLog.companyId,
      entityId: activityLog.entityId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    }).from(activityLog).innerJoin(issues, and(
      eq(issues.companyId, input.companyId),
      sql`${issues.id}::text = ${activityLog.entityId}`,
    )).innerJoin(missions, and(
      eq(missions.companyId, input.companyId),
      eq(missions.id, issues.missionId),
      inArray(missions.status, [...OPEN_MISSION_STATUSES]),
    )).where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION),
      eq(activityLog.entityType, "issue"),
    )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(candidateLimit);

    const basic = activityRows.flatMap((row) => {
      const payload = asPayload(row.details);
      if (!payload || !UUID.test(row.entityId)) return [];
      return [{ row, payload, details: isRecord(row.details) ? row.details : {} }];
    });
    const issueIds = [...new Set(basic.flatMap(({ row, payload }) => [
      ...(UUID.test(row.entityId) ? [row.entityId] : []),
      ...(typeof payload.sourceIssueId === "string" && UUID.test(payload.sourceIssueId) ? [payload.sourceIssueId] : []),
    ]))];
    const issueRows = issueIds.length ? await tx.select({
      id: issues.id, companyId: issues.companyId, missionId: issues.missionId,
      title: issues.title, status: issues.status, originKind: issues.originKind, originId: issues.originId,
    }).from(issues).where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIds))) : [];
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const missionIds = [...new Set(issueRows.flatMap((row) => row.missionId ? [row.missionId] : []))];
    const missionRows = missionIds.length ? await tx.select({
      id: missions.id, companyId: missions.companyId, title: missions.title, status: missions.status,
    }).from(missions).where(and(eq(missions.companyId, input.companyId), inArray(missions.id, missionIds))) : [];
    const missionById = new Map(missionRows.map((row) => [row.id, row]));

    const candidates: HumanOperatorRequestCandidate[] = [];
    const rendered: Array<{ row: (typeof activityRows)[number]; payload: HumanOperatorRequestPayload; mission: (typeof missionRows)[number]; owner: (typeof issueRows)[number]; source: (typeof issueRows)[number] | null; sourceValid: boolean }> = [];
    for (const { row, payload, details } of basic) {
      const owner = issueById.get(row.entityId);
      const mission = owner?.missionId ? missionById.get(owner.missionId) : null;
      if (!owner || !mission || !(OPEN_MISSION_STATUSES as readonly string[]).includes(mission.status)) continue;
      const source = typeof payload.sourceIssueId === "string" ? issueById.get(payload.sourceIssueId) ?? null : null;
      const sourceValid = sourceConsistent(payload, owner, source ?? undefined, input.companyId);
      if (!isOpen(owner.status) && !(sourceValid && source && isOpen(source.status))) continue;
      const candidate: HumanOperatorRequestCandidate = {
        activityId: row.activityId,
        companyId: row.companyId,
        missionId: mission.id,
        decisionEventId: payload.decisionEventId!,
        decisionKind: payload.decision,
        ownerActionIssueId: row.entityId,
        payloadOwnerIssueId: payload.issueId,
        payloadMissionId: payload.missionId,
        payloadCompanyId: details.companyId,
        sourceIssueId: typeof payload.sourceIssueId === "string" ? payload.sourceIssueId : null,
        sourceIsConsistent: sourceValid,
        workflowRunId: details.workflowRunId,
      };
      candidates.push(candidate);
      rendered.push({ row, payload, mission, owner, source, sourceValid });
    }
    const requestStates = await projectHumanRequestStates(tx, { companyId: input.companyId, candidates, now });
    const grouped = new Map<string, { request: HumanOperatorRequest; count: number }>();
    for (const { row, payload, mission, owner, source, sourceValid } of rendered) {
      const requestState = requestStates.get(row.activityId);
      if (!requestState) continue;
      const sourceOpen = Boolean(sourceValid && source && requestState.sourceIssueId === source.id
        && source.missionId === mission.id && isOpen(source.status));
      const targetIssueId = sourceOpen && source ? source.id : owner.id;
      const exactDecisionId = requestState.identity === "exact" ? requestState.decision?.id ?? "" : "";
      const key = `${input.companyId}|${mission.id}|${owner.id}|${requestState.decisionEventId}|${payload.decision}|${exactDecisionId}`;
      const existing = grouped.get(key);
      if (existing) { existing.count += 1; continue; }
      const title = payload.decision === "request_input" ? "Human/operator input requested" : "Mission blocker escalated";
      const timestamp = row.createdAt.toISOString();
      const actor = payload.actorType ? { type: payload.actorType, ...(payload.actorId ? { id: payload.actorId } : {}) } : undefined;
      const evidenceRefs = payload.commentId
        ? [{ type: "comment" as const, ref: payload.commentId, label: "mission owner decision" }]
        : [{ type: "log" as const, ref: payload.decisionEventId!, label: "mission owner decision" }];
      const event: GovernanceThreadEvent = {
        id: `owner_diagnosis:activity_log:${row.activityId}`, companyId: input.companyId,
        scope: { missionId: mission.id, issueId: targetIssueId },
        sourceRef: { type: "activity_log", id: row.activityId, table: "activity_log" },
        eventType: "owner_diagnosis", title, summary: compactSummary(payload, mission.title), timestamp,
        severity: payload.decision === "escalate" ? "blocked" : "attention",
        ...(actor ? { actor } : {}), evidenceRefs,
        suggestedResumeTarget: { action: "request_human_input", issueId: targetIssueId }, rawAvailable: true,
      };
      grouped.set(key, { count: 1, request: {
        id: `${mission.id}:${row.activityId}`, companyId: input.companyId, missionId: mission.id,
        missionTitle: mission.title, missionStatus: mission.status, issueId: targetIssueId,
        title, summary: event.summary, timestamp, count: 1, severity: event.severity, event, requestState,
      } });
    }
    return [...grouped.values()].slice(0, requestLimit).map((group) => ({ ...group.request, count: group.count }));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
