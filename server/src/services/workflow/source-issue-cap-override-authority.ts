import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueComments, issues, missions } from "@paperclipai/db";
import { extractMissionOwnerDecisionFromText } from "../missions/mission-owner-recovery-events.js";

const ACCEPTED_QUEUE_STATUSES = new Set(["queued", "claimed", "deferred_issue_execution", "coalesced", "completed"]);
const str = (value: unknown): string | null => typeof value === "string" ? value : null;

export async function findAcceptedWakeProof(
  db: Db,
  companyId: string,
  wakeKey: string,
  ctx: { workflowRunId: string; stepRunId: string; issueId: string },
  expectedWakeId?: string,
): Promise<{ id: string } | null> {
  const rows = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, wakeKey),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
      eq(agentWakeupRequests.workflowRunId, ctx.workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, ctx.stepRunId),
      eq(agentWakeupRequests.issueId, ctx.issueId),
    ));
  const accepted = rows.filter((row) => ACCEPTED_QUEUE_STATUSES.has(row.status));
  if (expectedWakeId) return accepted.find((row) => row.id === expectedWakeId) ?? null;
  return accepted[0] ?? null;
}

export async function validateOwnerDecisionComment(
  db: Db,
  companyId: string,
  input: {
    decisionCommentId: string;
    ownerActionIssueId: string;
    missionOwnerAgentId: string;
    producerCompletedAt: Date | null;
    producerIssueId: string;
    producerIdentifier: string | null;
  },
): Promise<{ commentId: string; createdAt: Date } | null> {
  const [row] = await db.select({
    id: issueComments.id,
    issueId: issueComments.issueId,
    authorAgentId: issueComments.authorAgentId,
    body: issueComments.body,
    createdAt: issueComments.createdAt,
  }).from(issueComments).where(and(
    eq(issueComments.id, input.decisionCommentId),
    eq(issueComments.companyId, companyId),
  )).limit(1);
  if (!row || row.issueId !== input.ownerActionIssueId || row.authorAgentId !== input.missionOwnerAgentId) return null;
  if (input.producerCompletedAt && row.createdAt.getTime() < input.producerCompletedAt.getTime()) return null;

  const latestRows = await db.select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, input.ownerActionIssueId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(32);
  const latestRecognized = latestRows.find((candidate) => extractMissionOwnerDecisionFromText(candidate.body ?? "") !== null);
  if (!latestRecognized || latestRecognized.id !== row.id) return null;

  const parsed = extractMissionOwnerDecisionFromText(row.body ?? "");
  if (!parsed || parsed.decision !== "retry_source_issue") return null;
  const targetRef = (parsed.reworkTargetRef ?? parsed.sourceIssueRef ?? "").trim().toLowerCase();
  const producerTokens = [input.producerIssueId, input.producerIdentifier]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (!targetRef || !producerTokens.includes(targetRef)) return null;
  return { commentId: row.id, createdAt: row.createdAt };
}

export async function hasCurrentCapOverrideAuthority(
  db: Db,
  companyId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const missionId = str(payload.missionId);
  const ownerActionIssueId = str(payload.ownerActionIssueId);
  const expectedOwnerAgentId = str(payload.missionOwnerAgentId);
  if (!missionId || !ownerActionIssueId || !expectedOwnerAgentId) return false;

  const [mission] = await db.select({ ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)))
    .limit(1);
  if (!mission || mission.ownerAgentId !== expectedOwnerAgentId) return false;

  const [ownerActionIssue] = await db.select({
    missionId: issues.missionId,
    originKind: issues.originKind,
    assigneeAgentId: issues.assigneeAgentId,
  }).from(issues).where(and(eq(issues.id, ownerActionIssueId), eq(issues.companyId, companyId))).limit(1);
  return !!ownerActionIssue &&
    ownerActionIssue.missionId === missionId &&
    ownerActionIssue.originKind === "mission_main_executor_unblock" &&
    ownerActionIssue.assigneeAgentId === mission.ownerAgentId;
}
