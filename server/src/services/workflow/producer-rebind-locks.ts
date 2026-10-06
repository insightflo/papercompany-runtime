import { and, eq } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { badRequest, conflict } from "../../errors.js";

/** Global order: mission → run → all step runs (id order) → product → claim. */
export async function lockProducerRebindScope(db: Db, companyId: string, runId: string) {
  const [scope] = await db.select({ missionId: workflowRuns.missionId }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId)));
  if (!scope) throw badRequest("producer rebind workflow run not found");
  if (scope.missionId) {
    const [mission] = await db.select().from(missions)
      .where(and(eq(missions.id, scope.missionId), eq(missions.companyId, companyId))).for("update");
    if (!mission || mission.status !== "active") throw conflict("producer_rebind_mission_not_active");
  }
  const [run] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))).for("update");
  if (!run || run.missionId !== scope.missionId) throw conflict("producer_rebind_scope_changed");
  if (run.status !== "failed") throw conflict("producer_rebind_run_not_failed");
  // workflow_step_runs has no company column; the scoped, locked parent proves tenant ownership.
  const rows = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, run.id)).orderBy(workflowStepRuns.id).for("update");
  return { run, rows };
}
