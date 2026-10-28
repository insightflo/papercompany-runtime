import { eq } from "drizzle-orm";
import { issues, missions, workflowRuns } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { startTerminalTransactionDatabase } from "./mission-terminal-transaction.js";

export async function startRuntimeReadinessMissionFixture() {
  const testDb = await startTerminalTransactionDatabase();
  const sweep = (companyId: string, missionIds?: string[]) =>
    missionService(testDb.db).runActiveMissionOwnerSupervision({
      companyId,
      missionIds,
      applySafeActions: true,
    });
  const mission = async (missionId: string) =>
    (await testDb.db.select().from(missions).where(eq(missions.id, missionId)))[0];
  const missionIssues = (missionId: string) =>
    testDb.db.select().from(issues).where(eq(issues.missionId, missionId)).orderBy(issues.id);
  const missionRuns = (missionId: string) =>
    testDb.db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId)).orderBy(workflowRuns.id);

  return { ...testDb, sweep, mission, missionIssues, missionRuns };
}
