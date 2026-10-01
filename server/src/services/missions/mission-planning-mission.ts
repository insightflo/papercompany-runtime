import { and, eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";

export async function loadPlanningMission(db: Db, input: { companyId: string; missionId: string }) {
  const [mission] = await db.select().from(missions).where(and(
    eq(missions.companyId, input.companyId), eq(missions.id, input.missionId))).limit(1);
  if (!mission) throw notFound(`Mission not found: ${input.missionId}`);
  return { id: mission.id, companyId: mission.companyId, ownerAgentId: mission.ownerAgentId,
    title: mission.title, description: mission.description, status: mission.status, goalId: mission.goalId,
    startedAt: mission.startedAt, completedAt: mission.completedAt, createdAt: mission.createdAt, updatedAt: mission.updatedAt };
}
