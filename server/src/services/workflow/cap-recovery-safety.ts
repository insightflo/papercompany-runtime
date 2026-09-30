import { eq } from "drizzle-orm";
import { missions, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "./replacement-execution-safety.js";

/** Caller owns the transaction. Always lock mission → run → steps before cap writes. */
export async function lockCapRecovery(db: Db, companyId: string, runId: string) {
  const run = await lockUnreplacedRun(db, runId, companyId);
  if (!run?.missionId) throw conflict("cap_recovery_scope_missing");
  const [mission] = await db.select().from(missions).where(eq(missions.id, run.missionId));
  if (!mission || mission.status !== "active") throw conflict("cap_recovery_mission_inactive");
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).orderBy(workflowStepRuns.id).for("update");
  if (await replacementBudgetBlocked(db, companyId, mission.ownerAgentId)) throw conflict("cap_recovery_budget_blocked");
  if (await replacementExecutionInFlight(db, companyId, run.id, steps)) throw conflict("cap_recovery_execution_in_flight");
  return { run, steps };
}
