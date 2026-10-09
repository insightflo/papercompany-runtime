import { and, asc, desc, eq, isNull } from "drizzle-orm";
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

  const commentsByIssueId = new Map<string, string[]>();
  for (const ownerActionIssue of ownerActionIssues) {
    const ownerActionCommentRows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, ownerActionIssue.id)))
      .orderBy(asc(issueComments.createdAt));
    commentsByIssueId.set(ownerActionIssue.id, ownerActionCommentRows.map((comment) => comment.body));
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
  const agentRows = await db
    .select({
      row: missionAgents,
      agentName: agents.name,
    })
    .from(missionAgents)
    .leftJoin(agents, eq(missionAgents.agentId, agents.id))
    .where(eq(missionAgents.missionId, id));

  const [ownerRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, mission.ownerAgentId))
    .limit(1);
  const sessionBindings = await db
    .select({
      agentId: missionSessions.agentId,
      adapterType: missionSessions.adapterType,
      status: missionSessions.status,
      lastActiveAt: missionSessions.lastActiveAt,
      runCount: missionSessions.runCount,
    })
    .from(missionSessions)
    .where(eq(missionSessions.missionId, id))
    .orderBy(desc(missionSessions.lastActiveAt), asc(missionSessions.agentId));

  const activeMissionPlan = await missionPlanArtifactService(db).getActiveMissionPlan({
    companyId: mission.companyId,
    missionId: id,
  });
  const ownerActionExplanations = await buildMissionOwnerActionExplanations(db, mission);
  const project = mission.projectId ? await resolveProjectRef(db, mission.projectId) : null;

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
