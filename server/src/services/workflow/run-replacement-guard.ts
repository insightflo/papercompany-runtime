import { and, eq } from "drizzle-orm";
import { missions, workflowRuns, workflowRecoveryAuthorities, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";

// Call inside the mutation transaction, before any step/queue/issue write.
export async function lockUnreplacedRun(db: Db, runId: string, companyId: string) {
  const [observed] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId)));
  if (!observed) return null;
  if (observed.missionId) {
    const [mission] = await db.select().from(missions).where(and(eq(missions.id, observed.missionId), eq(missions.companyId, companyId))).for("update");
    if (!mission || mission.status === "cancelled") throw conflict("workflow_mission_cancelled");
  }
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))).for("update");
  if (!run || run.missionId !== observed.missionId) throw conflict("workflow_run_scope_changed");
  await assertRunNotReplaced(db, runId, companyId);
  if (run.status === "cancelled") throw conflict("workflow_run_resume_not_allowed: terminal status cancelled");
  return run;
}
export async function assertRunNotReplaced(db: Pick<Db, "select">, runId: string, companyId: string) {
  const [replacement] = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, companyId), eq(workflowRecoveryAuthorities.workflowRunId, runId),
    eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"))).limit(1);
  if (replacement) throw conflict("workflow_run_replaced");
}
