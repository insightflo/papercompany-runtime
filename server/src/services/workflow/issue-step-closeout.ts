import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";

type WorkflowStepRunWriteDb = Pick<Db, "select" | "update">;

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

export async function completeLinkedWorkflowStepRunsForIssue(input: {
  db: WorkflowStepRunWriteDb;
  issueId: string;
  completedAt: Date;
}): Promise<string[]> {
  const linkedStepRuns = await input.db
    .select({
      id: workflowStepRuns.id,
      startedAt: workflowStepRuns.startedAt,
    })
    .from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.issueId, input.issueId), ACTIVE_STEP_STATUS_CONDITION));

  const completedIds: string[] = [];
  for (const stepRun of linkedStepRuns) {
    const [updated] = await input.db
      .update(workflowStepRuns)
      .set({
        status: "completed",
        startedAt: stepRun.startedAt ?? input.completedAt,
        completedAt: input.completedAt,
      })
      .where(and(eq(workflowStepRuns.id, stepRun.id), ACTIVE_STEP_STATUS_CONDITION))
      .returning({ id: workflowStepRuns.id });
    if (updated) completedIds.push(updated.id);
  }

  return completedIds;
}
