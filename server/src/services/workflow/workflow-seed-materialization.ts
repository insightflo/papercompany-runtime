import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowRunSeeds, workflowStepRuns, type Db } from "@paperclipai/db";
import { seedError, verifySeedEvidence } from "./workflow-seed-evidence.js";

/** Called only within the existing run-row lock and initial step INSERT transaction. */
export async function seedInitialRows(db: Db, runId: string, missingStepIds: string[]) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  const rows = await db.select().from(workflowRunSeeds).where(and(eq(workflowRunSeeds.targetRunId, runId), eq(workflowRunSeeds.companyId, run!.companyId)));
  const patches = new Map<string, Partial<typeof workflowStepRuns.$inferInsert>>();
  for (const seed of rows) {
    if (!missingStepIds.includes(seed.targetStepId)) continue;
    if (run!.parentRunId || run!.parentStepRunId) throw seedError("unsupported_combination");
    await verifySeedEvidence(db, seed);
    const now = new Date();
    patches.set(seed.targetStepId, { id: seed.targetStepRunId, status: "completed", issueId: null,
      completedAt: now, evidenceReadyAt: now, dispatchReadyAt: now });
  }
  return patches;
}
