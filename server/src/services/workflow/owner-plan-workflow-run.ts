import { and, eq } from "drizzle-orm";
import { missions, workflowRuns, type Db } from "@paperclipai/db";
import { createWorkflowRun } from "./workflow-store.js";
import { executeWorkflowRun } from "./dag-engine.js";

/** Revision PLAN creates the definition, but board must explicitly choose seed or fresh start. */
export async function ensureOwnerPlanWorkflowRun(input: { db: Db; companyId: string; missionId: string;
  workflowId: string; triggeredBy: string; requirePlanQaPass: () => Promise<void> }): Promise<string | null> {
  const [existing] = await input.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.workflowId, input.workflowId), eq(workflowRuns.missionId, input.missionId))).limit(1);
  if (existing) return existing.id;
  const [mission] = await input.db.select().from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)));
  if (mission?.sourceMissionId) return null;
  await input.requirePlanQaPass();
  const run = await createWorkflowRun(input.db, input);
  await input.requirePlanQaPass();
  await executeWorkflowRun(input.db, run.id);
  return run.id;
}
