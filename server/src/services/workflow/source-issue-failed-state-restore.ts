import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";

export async function restoreFailedSourceIssueWorkflowState(
  db: Db,
  run: Pick<typeof workflowRuns.$inferSelect, "id" | "companyId" | "missionId" | "startedAt" | "completedAt">,
  stepRun: Pick<typeof workflowStepRuns.$inferSelect, "id" | "workflowRunId" | "status" | "completedAt">,
): Promise<void> {
  const [currentStepRun] = await db
    .select({
      status: workflowStepRuns.status,
      transitionVersion: workflowStepRuns.statusTransitionVersion,
    })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.id, stepRun.id),
      eq(workflowStepRuns.workflowRunId, run.id),
    ));

  await db
    .update(workflowRuns)
    .set({ status: "failed", startedAt: run.startedAt, completedAt: run.completedAt })
    .where(eq(workflowRuns.id, run.id));
  const [restoredStepRun] = await db
    .update(workflowStepRuns)
    .set({ status: "failed", completedAt: stepRun.completedAt })
    .where(eq(workflowStepRuns.id, stepRun.id))
    .returning({
      id: workflowStepRuns.id,
      transitionVersion: workflowStepRuns.statusTransitionVersion,
    });
  if (!currentStepRun || !restoredStepRun) return;

  await recordWorkflowStepStatusTransition(db, {
    companyId: run.companyId,
    missionId: run.missionId,
    workflowRunId: run.id,
    workflowStepRunId: stepRun.id,
    fromStatus: currentStepRun.status,
    toStatus: "failed",
    source: "workflow_source_issue_resume",
    transitionVersion: restoredStepRun.transitionVersion > currentStepRun.transitionVersion
      ? restoredStepRun.transitionVersion
      : null,
  });
}
