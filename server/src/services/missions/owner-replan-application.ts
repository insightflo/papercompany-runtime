import { issues, missions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createIssueRecord } from "../issue-create-records.js";
import type { MissionRow } from "../missions.js";
import { listCompanyExecutionCandidates, formatCandidateRosterLines } from "./mission-execution-candidates.js";
import { buildRevisionMissionPlanningDescription } from "./mission-revision-planning.js";
import { missionPlanTemplateService } from "./mission-plan-templates.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";

const RUNNABLE_PLAN_STATUSES = ["backlog", "todo", "in_progress", "in_review"];

export type OwnerReplanApplication = {
  planningIssue: typeof issues.$inferSelect;
  resultStatus: "created" | "reused";
};

/**
 * Turns an authoritative replan decision into runnable planning work.
 * Mission then owner-action row locks match decision submission order, so the latest decision and
 * current owner remain stable while an existing planning attempt is reused or a new one is created.
 */
export async function applyOwnerReplanDecision(input: {
  db: Db;
  mission: MissionRow;
  ownerActionIssueId: string;
  expectedDecisionEventId: string;
}): Promise<OwnerReplanApplication | null> {
  return input.db.transaction(async (tx) => {
    const [mission] = await tx
      .select({
        id: missions.id,
        companyId: missions.companyId,
        ownerAgentId: missions.ownerAgentId,
        title: missions.title,
        description: missions.description,
        status: missions.status,
      })
      .from(missions)
      .where(and(eq(missions.companyId, input.mission.companyId), eq(missions.id, input.mission.id)))
      .for("update");
    if (!mission || mission.status === "completed" || mission.status === "cancelled") return null;

    const [ownerAction] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.id, input.ownerActionIssueId),
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
      ))
      .for("update");
    if (!ownerAction) return null;

    const currentDecision = await loadLatestMissionOwnerDecision({
      db: tx,
      companyId: mission.companyId,
      ownerActionIssueId: ownerAction.id,
    });
    if (
      currentDecision?.eventId !== input.expectedDecisionEventId
      || currentDecision.missionId !== mission.id
      || currentDecision.authorAgentId !== mission.ownerAgentId
      || currentDecision.decision.decision !== "replan_mission"
    ) return null;

    const [existing] = await tx
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_plan"),
        eq(issues.assigneeAgentId, mission.ownerAgentId),
        inArray(issues.status, RUNNABLE_PLAN_STATUSES),
        isNull(issues.hiddenAt),
      ))
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(1);
    if (existing) return { planningIssue: existing, resultStatus: "reused" };

    const txDb = tx as unknown as Db;
    const candidates = await listCompanyExecutionCandidates(txDb, mission.companyId);
    const planTemplateCatalog = await missionPlanTemplateService(txDb).list(mission.companyId, { includeDisabled: false });
    const description = await buildRevisionMissionPlanningDescription(txDb, {
      companyId: mission.companyId,
      missionId: mission.id,
      title: mission.title,
      description: mission.description,
      runnableCandidates: candidates,
      runnableRosterLines: formatCandidateRosterLines(candidates, mission.ownerAgentId),
      planTemplateCatalog,
    });
    const planningIssue = await createIssueRecord(
      tx,
      mission.companyId,
      {
        assigneeAgentId: mission.ownerAgentId,
        description,
        missionId: mission.id,
        originKind: "mission_main_executor_plan",
        originId: ownerAction.id,
        priority: "medium",
        status: "todo",
        title: `[PLAN] ${mission.title}`,
      },
      false,
    );
    return { planningIssue, resultStatus: "created" };
  });
}
