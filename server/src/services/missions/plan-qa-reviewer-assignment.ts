import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import type { ArtifactRef } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES } from "./agent-role-boundaries.js";
import { blockedPlanQaTemplates, readPlanQaManifestForIssue } from "./plan-qa-addendum-manifest.js";
import { ensurePlanQaReviewBinding, planQaReviewBindingMarkerSchema } from "./plan-qa-review-binding.js";

const RUNNABLE_STATUSES = RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES;
export const PLAN_QA_VERDICT_AGENT_ROLES = new Set(["qa", "reviewer", "validator"]);

export type PlanQaWakeupHandler = (input: {
  companyId: string;
  agentId: string;
  issueId: string;
  issueStatus: string;
  missionId: string;
  planningIssueId: string | null;
}) => Promise<unknown> | unknown;

async function findReviewer(
  db: Db,
  companyId: string,
  preferredReviewerAgentId?: string | null,
): Promise<string | null> {
  if (preferredReviewerAgentId !== undefined) {
    if (!preferredReviewerAgentId) return null;
    const [preferred] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        eq(agents.id, preferredReviewerAgentId),
        inArray(agents.status, Array.from(RUNNABLE_STATUSES)),
      ))
      .limit(1);
    return preferred?.id ?? null;
  }
  const [candidate] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      inArray(agents.role, Array.from(PLAN_QA_VERDICT_AGENT_ROLES)),
      inArray(agents.status, Array.from(RUNNABLE_STATUSES)),
    ))
    .orderBy(sql`case ${agents.status} when 'idle' then 0 when 'active' then 1 when 'running' then 2 else 3 end`, agents.createdAt)
    .limit(1);
  return candidate?.id ?? null;
}

async function loadAgentStatus(db: Db, companyId: string, agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const [agent] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1);
  return agent?.status ?? null;
}

function isActionable(status: string): boolean {
  return status !== "backlog" && status !== "blocked" && status !== "done" && status !== "cancelled";
}

async function assignReviewer(input: {
  db: Db;
  companyId: string;
  planQaIssueId: string;
  currentAssigneeAgentId: string | null;
  currentIssueStatus: string;
  missionId: string;
  planningIssueId: string | null;
  preferredReviewerAgentId?: string | null;
  reopenBlocked: boolean;
}): Promise<{ agentId: string; issueStatus: string } | null> {
  const assigneeAgentId = await findReviewer(input.db, input.companyId, input.preferredReviewerAgentId);
  if (!assigneeAgentId) return null;
  const [updated] = await input.db
    .update(issues)
    .set({
      assigneeAgentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      ...(input.reopenBlocked ? { status: "todo" as const } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      input.currentAssigneeAgentId
        ? eq(issues.assigneeAgentId, input.currentAssigneeAgentId)
        : isNull(issues.assigneeAgentId),
      eq(issues.status, input.currentIssueStatus as typeof issues.$inferSelect.status),
      isNull(issues.hiddenAt),
    ))
    .returning({ assigneeAgentId: issues.assigneeAgentId, status: issues.status });
  if (updated?.assigneeAgentId) {
    await logActivity(input.db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "mission-plan-qa",
      action: "mission.plan_qa.issue_assignee_reselected",
      entityType: "mission",
      entityId: input.missionId,
      details: {
        planningIssueId: input.planningIssueId,
        planQaIssueId: input.planQaIssueId,
        fromAgentId: input.currentAssigneeAgentId,
        toAgentId: updated.assigneeAgentId,
        previousStatus: input.currentIssueStatus,
        nextStatus: updated.status,
      },
    });
    return { agentId: updated.assigneeAgentId, issueStatus: updated.status };
  }

  const [current] = await input.db
    .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  const currentAgentStatus = await loadAgentStatus(input.db, input.companyId, current?.assigneeAgentId ?? null);
  const currentMatchesPreferred = input.preferredReviewerAgentId === undefined
    || current?.assigneeAgentId === input.preferredReviewerAgentId;
  if (
    current?.assigneeAgentId
    && currentAgentStatus
    && RUNNABLE_STATUSES.has(currentAgentStatus)
    && currentMatchesPreferred
  ) {
    return { agentId: current.assigneeAgentId, issueStatus: current.status };
  }
  return null;
}

async function resolveAssignment(input: {
  db: Db;
  companyId: string;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  missionId: string;
  planningIssueId: string | null;
  preferredReviewerAgentId?: string | null;
}): Promise<{ agentId: string; issueStatus: string } | null> {
  const agentStatus = await loadAgentStatus(input.db, input.companyId, input.issue.assigneeAgentId);
  const currentIsRunnable = Boolean(agentStatus && RUNNABLE_STATUSES.has(agentStatus));
  const matchesPreferred = input.preferredReviewerAgentId === undefined
    || input.issue.assigneeAgentId === input.preferredReviewerAgentId;
  if (currentIsRunnable && (matchesPreferred || input.issue.status === "in_progress")) {
    return { agentId: input.issue.assigneeAgentId!, issueStatus: input.issue.status };
  }
  const recoverFailedRun = input.issue.status === "blocked" && agentStatus === "error";
  if (!isActionable(input.issue.status) && !recoverFailedRun) return null;
  return assignReviewer({
    db: input.db,
    companyId: input.companyId,
    planQaIssueId: input.issue.id,
    currentAssigneeAgentId: input.issue.assigneeAgentId,
    currentIssueStatus: input.issue.status,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
    preferredReviewerAgentId: input.preferredReviewerAgentId,
    reopenBlocked: recoverFailedRun,
  });
}

async function wake(input: {
  enqueue?: PlanQaWakeupHandler;
  companyId: string;
  assignment: { agentId: string; issueStatus: string } | null;
  issueId: string;
  missionId: string;
  planningIssueId: string | null;
}): Promise<void> {
  if (!input.enqueue || !input.assignment || !isActionable(input.assignment.issueStatus)) return;
  await input.enqueue({
    companyId: input.companyId,
    agentId: input.assignment.agentId,
    issueId: input.issueId,
    issueStatus: input.assignment.issueStatus,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
  });
}

export type PlanQaReviewIssueBinding = {
  id: string;
  reviewGeneration: number | null;
  manifestRef: ArtifactRef | null;
  blockedTemplateIds: string[] | null;
};

export async function ensurePlanQaReviewIssue(input: {
  db: Db;
  companyId: string;
  missionId: string;
  missionTitle: string;
  missionDescription: string | null;
  planningIssueId: string | null;
  decisionHash: string;
  missionGoal?: string | null;
  preferredReviewerAgentId?: string | null;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  planArtifactId: string;
  existingIssueId?: string | null;
}): Promise<PlanQaReviewIssueBinding> {
  // [T7] 검토 issue 생성·서버 표식·명세 연결은 binding tx 안에서 확정된 뒤에만 실행 요청(wake)한다.
  const reviewerUnavailableHint = (await findReviewer(input.db, input.companyId, input.preferredReviewerAgentId)) === null;
  const binding = await ensurePlanQaReviewBinding({
    db: input.db,
    companyId: input.companyId,
    missionId: input.missionId,
    planArtifactId: input.planArtifactId,
    decisionHash: input.decisionHash,
    missionTitle: input.missionTitle,
    missionDescription: input.missionDescription,
    missionGoal: input.missionGoal,
    planningIssueId: input.planningIssueId,
    reviewerUnavailableHint,
    existingIssueId: input.existingIssueId,
  });
  if (binding.kind === "completed") {
    return { id: binding.issueId, reviewGeneration: null, manifestRef: null, blockedTemplateIds: null };
  }
  if (binding.blockedTemplateIds.length) {
    // base_changed(required): 신규 실행 차단 — 배정/실행 요청을 하지 않는다.
    return { id: binding.issueId, reviewGeneration: binding.reviewGeneration, manifestRef: binding.manifestRef, blockedTemplateIds: binding.blockedTemplateIds };
  }
  const [issue] = await input.db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, binding.issueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  if (!issue) {
    return { id: binding.issueId, reviewGeneration: binding.reviewGeneration, manifestRef: binding.manifestRef, blockedTemplateIds: [] };
  }
  const assignment = await resolveAssignment({
    db: input.db,
    companyId: input.companyId,
    issue,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
    preferredReviewerAgentId: input.preferredReviewerAgentId,
  });
  await wake({ enqueue: input.enqueuePlanQaWakeup, companyId: input.companyId, assignment, issueId: issue.id, missionId: input.missionId, planningIssueId: input.planningIssueId });
  return { id: binding.issueId, reviewGeneration: binding.reviewGeneration, manifestRef: binding.manifestRef, blockedTemplateIds: [] };
}

export async function ensurePlanQaWakeupForIssue(input: {
  db: Db;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  companyId: string;
  planQaIssueId: string;
  missionId: string;
  planningIssueId: string | null;
  preferredReviewerAgentId?: string | null;
}): Promise<void> {
  const [issue] = await input.db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status, marker: issues.qualityPlanQaBinding })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  if (!issue) return;
  // [T7 fix] base_changed(required) 로 차단된 검토는 같은 decisionHash 재진입에서도 배정/기상하지
  // 않는다. 신형 binding marker(기계 계약)에서 고정 명세를 읽어 차단 여부를 확인한다.
  // marker 없는 구형 이슈는 기존 동작을 유지한다.
  const marker = planQaReviewBindingMarkerSchema.safeParse(issue.marker);
  if (marker.success) {
    const manifest = await readPlanQaManifestForIssue(input.db, input.companyId, issue.id, marker.data.manifestRef);
    if (blockedPlanQaTemplates(manifest).length) return;
  }
  const assignment = await resolveAssignment({
    db: input.db,
    companyId: input.companyId,
    issue,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
    preferredReviewerAgentId: input.preferredReviewerAgentId,
  });
  await wake({ enqueue: input.enqueuePlanQaWakeup, companyId: input.companyId, assignment, issueId: issue.id, missionId: input.missionId, planningIssueId: input.planningIssueId });
}
