import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { recordWorkflowStepStatusTransitions } from "./workflow-sync-source.js";

type WorkflowRunScope = {
  id: string;
  companyId: string;
  missionId: string | null;
};

type WorkflowStepRun = typeof workflowStepRuns.$inferSelect;

const terminalStepStatuses = new Set(["completed", "failed", "skipped", "cancelled", "canceled"]);

export async function syncCancelledWorkflowRunState(input: {
  db: Db;
  run: WorkflowRunScope;
  syncStepRunsFromIssueState: (
    db: Db,
    stepRuns: WorkflowStepRun[],
  ) => Promise<WorkflowStepRun[]>;
}): Promise<void> {
  let stepRuns = await input.db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.run.id));
  const priorStatusByStepRunId = new Map(stepRuns.map((stepRun) => [stepRun.id, stepRun.status]));
  if (stepRuns.length === 0) return;

  stepRuns = await input.syncStepRunsFromIssueState(input.db, stepRuns);
  const now = new Date();
  for (const stepRun of stepRuns) {
    if (terminalStepStatuses.has(stepRun.status)) continue;
    await input.db
      .update(workflowStepRuns)
      .set(stepRun.issueId
        ? { status: "failed", startedAt: stepRun.startedAt ?? now, completedAt: stepRun.completedAt ?? now }
        : { status: "skipped", completedAt: stepRun.completedAt ?? now })
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  const finalStepRuns = await input.db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.run.id));
  await recordWorkflowStepStatusTransitions(input.db, {
    companyId: input.run.companyId,
    missionId: input.run.missionId,
    workflowRunId: input.run.id,
    source: "workflow_cancellation",
    priorStatusByStepRunId,
    stepRuns: finalStepRuns,
  });
}
