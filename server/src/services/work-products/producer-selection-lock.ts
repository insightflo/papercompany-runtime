import { and, asc, eq, inArray, or } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";

/** Call inside the write transaction. Row locks guard future inserts, not just existing products.
 * Registration holds SHARE through INSERT; first selection holds UPDATE through every pin.
 * Both follow mission → run → sorted step IDs (including the consumer before its pin FK).
 */
export async function lockProducerSelection(db: Pick<Db, "select">, input: {
  companyId: string; workflowRunId: string; stepIds?: string[]; stepRunIds?: string[];
}, mode: "share" | "update") {
  const scope = and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId));
  const [observed] = await db.select().from(workflowRuns).where(scope);
  if (observed?.missionId) {
    await db.select({ id: missions.id }).from(missions)
      .where(and(eq(missions.id, observed.missionId), eq(missions.companyId, input.companyId))).for(mode);
  }
  const [run] = await db.select().from(workflowRuns).where(scope).for(mode);
  const steps = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, input.workflowRunId),
    or(inArray(workflowStepRuns.stepId, input.stepIds ?? []), inArray(workflowStepRuns.id, input.stepRunIds ?? [])),
  )).orderBy(asc(workflowStepRuns.id)).for(mode);
  return { run, steps };
}
