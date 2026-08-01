import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  recordWorkflowStepStatusTransition,
  type WorkflowSyncSource,
} from "./workflow-sync-source.js";

type WorkflowStepRunWriteDb = Pick<Db, "select" | "update" | "insert" | "transaction">;

const ACTIVE_STEP_STATUS_CONDITION = sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`;

export async function completeLinkedWorkflowStepRunsForIssue(input: {
  db: WorkflowStepRunWriteDb;
  issueId: string;
  completedAt: Date;
  source?: WorkflowSyncSource;
  heartbeatRunId?: string | null;
}): Promise<string[]> {
  const linkedStepRuns = await input.db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      issueId: workflowStepRuns.issueId,
      status: workflowStepRuns.status,
      startedAt: workflowStepRuns.startedAt,
      companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
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
      .returning({
        id: workflowStepRuns.id,
        transitionVersion: workflowStepRuns.statusTransitionVersion,
      });
    if (!updated) continue;
    completedIds.push(updated.id);
    await recordWorkflowStepStatusTransition(input.db, {
      companyId: stepRun.companyId,
      missionId: stepRun.missionId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
      issueId: stepRun.issueId,
      fromStatus: stepRun.status,
      toStatus: "completed",
      source: input.source ?? "workflow_issue_closeout",
      heartbeatRunId: input.heartbeatRunId,
      transitionVersion: updated.transitionVersion,
    });
  }

  return completedIds;
}
