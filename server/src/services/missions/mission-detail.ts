import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues, missionAgents, missionSessions, projects } from "@paperclipai/db";
import type { MissionDetail, MissionProjectRef, MissionRow } from "../missions.js";
import { missionPlanArtifactService, summarizeMissionPlanForRuntime } from "../mission-plan-artifacts.js";
import { buildOwnerActionExplanations, type MissionOwnerActionExplanation } from "./mission-owner-recovery-explanations.js";

async function buildMissionOwnerActionExplanations(db: Db, mission: MissionRow): Promise<MissionOwnerActionExplanation[]> {
  const ownerActionIssues = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, mission.companyId),
      eq(issues.missionId, mission.id),
      eq(issues.originKind, "mission_main_executor_unblock"),
      isNull(issues.hiddenAt),
    ));

  const ownerActionIssueIds = ownerActionIssues.map((ownerActionIssue) => ownerActionIssue.id);
  const commentsByIssueId = new Map<string, string[]>();
  for (const ownerActionIssueId of ownerActionIssueIds) {
    commentsByIssueId.set(ownerActionIssueId, []);
  }
  if (ownerActionIssueIds.length > 0) {
    // [목적] owner-action 이슈별 댓글을 한 번에 읽는다(이슈 수만큼 쿼리를 반복하던 N+1 제거).
    // [주의] 기존과 같은 createdAt 오름차순을 유지해야 이슈별 본문 순서가 달라지지 않는다.
    //        이슈별 그룹핑이 섮이면 다른 이슈의 결정 표시가 붙으므로 아래 테스트가 교차 오염을 고정한다.
    const ownerActionCommentRows = await db
      .select({ issueId: issueComments.issueId, body: issueComments.body })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, mission.companyId),
        inArray(issueComments.issueId, ownerActionIssueIds),
      ))
      .orderBy(asc(issueComments.createdAt));
    for (const comment of ownerActionCommentRows) {
      commentsByIssueId.get(comment.issueId)?.push(comment.body);
    }
  }

  return buildOwnerActionExplanations({
    ownerActionIssues,
    commentsByIssueId,
    resolveSourceIssue: async (sourceIssueId) => db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(
        eq(issues.id, sourceIssueId),
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        isNull(issues.hiddenAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    resolveSourceComments: async (sourceIssueId) => db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, sourceIssueId)))
      .then((rows) => rows.map((comment) => comment.body)),
  });
}

async function resolveProjectRef(db: Db, projectId: string): Promise<MissionProjectRef | null> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, color: projects.color })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ? { id: row.id, name: row.name, color: row.color } : null;
}

/** Read-only detail projection; callers own any lifecycle reconciliation. */
export async function buildMissionDetail(db: Db, mission: MissionRow): Promise<MissionDetail> {
  const id = mission.id;
  // [목적] 서로 독립인 조회를 병렬로 보낸다. DB 왕복이 느려지는 구간(백업·포화)에서 직렬 누적을 줄인다.
  // [주의] 반환 객체의 필드 순서·내용은 기존과 같다(모두 이 mission 행에만 의존하는 읽기).
  const [agentRows, ownerRows, sessionBindings, activeMissionPlan, ownerActionExplanations, project] = await Promise.all([
    db
      .select({
        row: missionAgents,
        agentName: agents.name,
      })
      .from(missionAgents)
      .leftJoin(agents, eq(missionAgents.agentId, agents.id))
      .where(eq(missionAgents.missionId, id)),
    db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, mission.ownerAgentId))
      .limit(1),
    db
      .select({
        agentId: missionSessions.agentId,
        adapterType: missionSessions.adapterType,
        status: missionSessions.status,
        lastActiveAt: missionSessions.lastActiveAt,
        runCount: missionSessions.runCount,
      })
      .from(missionSessions)
      .where(eq(missionSessions.missionId, id))
      .orderBy(desc(missionSessions.lastActiveAt), asc(missionSessions.agentId)),
    missionPlanArtifactService(db).getActiveMissionPlan({
      companyId: mission.companyId,
      missionId: id,
    }),
    buildMissionOwnerActionExplanations(db, mission),
    mission.projectId ? resolveProjectRef(db, mission.projectId) : Promise.resolve(null),
  ]);
  const [ownerRow] = ownerRows;

  return {
    ...mission,
    agents: agentRows.map((r: { row: typeof missionAgents.$inferSelect; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined })),
    ownerAgentName: ownerRow?.name,
    project,
    sessionBindings,
    activeMissionPlan: summarizeMissionPlanForRuntime(activeMissionPlan),
    ownerActionExplanations,
  };
}
