import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { listMissionExecutionSourceSnapshots, type MissionExecutionSourceSnapshot } from "./mission-execution-sources.js";

export type MissionSupervisionMission = typeof missions.$inferSelect;
export type MissionSupervisionIssue = typeof issues.$inferSelect;
export type MissionSupervisionWorkflowStepRow = {
  stepRun: typeof workflowStepRuns.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
};
export type MissionSupervisionPlanArtifact = typeof missionPlanArtifacts.$inferSelect;

export type MissionSupervisionContext = {
  mission: MissionSupervisionMission;
  missionIssues: MissionSupervisionIssue[];
  missionIssueById: Map<string, MissionSupervisionIssue>;
  commentsByIssueId: Map<string, string[]>;
  heartbeatCountByIssueId: Map<string, number>;
  stepRows: MissionSupervisionWorkflowStepRow[];
  stepRowsByIssueId: Map<string, MissionSupervisionWorkflowStepRow[]>;
  executionSnapshot: MissionExecutionSourceSnapshot;
  activePlan: MissionSupervisionPlanArtifact | null;
};

export async function buildMissionSupervisionContext(
  db: Db,
  input: { missionId: string },
): Promise<MissionSupervisionContext> {
  const mission = await db
    .select()
    .from(missions)
    .where(eq(missions.id, input.missionId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

  const missionIssues = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id)))
    .orderBy(asc(issues.createdAt), asc(issues.id));

  const missionIssueIds = missionIssues.map((issue) => issue.id);
  const missionIssueById = new Map(missionIssues.map((issue) => [issue.id, issue]));
  const issueCommentRows = missionIssueIds.length > 0
    ? await db
      .select({ issueId: issueComments.issueId, body: issueComments.body })
      .from(issueComments)
      .where(inArray(issueComments.issueId, missionIssueIds))
    : [];
  const commentsByIssueId = new Map<string, string[]>();
  for (const comment of issueCommentRows) {
    const list = commentsByIssueId.get(comment.issueId) ?? [];
    list.push(comment.body);
    commentsByIssueId.set(comment.issueId, list);
  }

  const issueRunRows = missionIssueIds.length > 0
    ? await db
      .select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, mission.companyId), inArray(heartbeatRuns.issueId, missionIssueIds)))
    : [];
  const heartbeatCountByIssueId = new Map<string, number>();
  for (const run of issueRunRows) {
    if (!run.issueId) continue;
    heartbeatCountByIssueId.set(run.issueId, (heartbeatCountByIssueId.get(run.issueId) ?? 0) + 1);
  }

  const stepRows = await db
    .select({
      stepRun: workflowStepRuns,
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)))
    .orderBy(asc(workflowRuns.createdAt), asc(workflowStepRuns.stepId));
  const stepRowsByIssueId = new Map<string, MissionSupervisionWorkflowStepRow[]>();
  for (const row of stepRows) {
    if (!row.stepRun.issueId) continue;
    const list = stepRowsByIssueId.get(row.stepRun.issueId) ?? [];
    list.push(row);
    stepRowsByIssueId.set(row.stepRun.issueId, list);
  }

  const snapshots = await listMissionExecutionSourceSnapshots(db, {
    companyId: mission.companyId,
    missionIds: [mission.id],
  });
  const executionSnapshot = snapshots[mission.id] ?? { missionId: mission.id, companyId: mission.companyId, units: [] };

  const [activePlan] = await db
    .select()
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, mission.companyId),
      eq(missionPlanArtifacts.missionId, mission.id),
      eq(missionPlanArtifacts.status, "active"),
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.updatedAt));

  return {
    mission,
    missionIssues,
    missionIssueById,
    commentsByIssueId,
    heartbeatCountByIssueId,
    stepRows,
    stepRowsByIssueId,
    executionSnapshot,
    activePlan: activePlan ?? null,
  };
}
