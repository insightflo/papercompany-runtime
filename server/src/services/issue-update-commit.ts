import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { getProjectDefaultGoalId, syncIssueLabels, type IssueWriteDb } from "./issue-create-records.js";
import { resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import { logger } from "../middleware/logger.js";
import { resyncIssueExecutionCardAfterIssueUpdate } from "./issue-execution-cards/resync.js";
import { persistTerminalIssueHandoff } from "./missions/issue-terminal-handoff.js";
import { closeLockedOwnerHumanSettlements, lockSourceOwnerHumanSettlement } from "./missions/mission-work-settlement.js";
import { completeWorkflowIssueStepRunsAfterDone } from "./workflow/work-product-completion-gate.js";
import type { WorkflowSyncSource } from "./workflow/workflow-sync-source.js";

type IssueRow = typeof issues.$inferSelect;
type IssueUpdateCommitInput<T extends IssueRow> = {
  db: Db;
  id: string;
  existing: IssueRow;
  issueData: Partial<typeof issues.$inferInsert>;
  patch: Partial<typeof issues.$inferInsert>;
  nextLabelIds: string[] | undefined;
  workflowSyncSource: WorkflowSyncSource;
  withIssueLabels: (dbOrTx: IssueWriteDb, rows: IssueRow[]) => Promise<T[]>;
};

export async function commitIssueUpdate<T extends IssueRow>({
  db,
  id,
  existing,
  issueData,
  patch,
  nextLabelIds,
  workflowSyncSource,
  withIssueLabels,
}: IssueUpdateCommitInput<T>): Promise<T | null> {
  const updatedIssue = await db.transaction(async (tx) => {
    const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
    const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
      getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
      getProjectDefaultGoalId(
        tx,
        existing.companyId,
        issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
      ),
    ]);
    const resolvedNextGoalId =
      issueData.goalId !== undefined
        ? issueData.goalId
        : (nextProjectGoalId ?? currentProjectGoalId ?? existing.goalId);
    patch.goalId = resolveNextIssueGoalId({
      currentProjectId: existing.projectId,
      currentGoalId: existing.goalId,
      projectId: issueData.projectId,
      goalId: resolvedNextGoalId,
      defaultGoalId: defaultCompanyGoal?.id ?? null,
    });
    const ownerHuman = existing.missionId && issueData.status !== existing.status
      && (issueData.status === "done" || issueData.status === "cancelled")
      ? await lockSourceOwnerHumanSettlement(tx, { companyId: existing.companyId,
        missionId: existing.missionId, sourceIssueId: existing.id }) : null;
    const updated = await tx
      .update(issues)
      .set(patch)
      .where(eq(issues.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    await closeLockedOwnerHumanSettlements(ownerHuman ? [ownerHuman] : []);
    if (issueData.status === "done" && existing.status !== "done") {
      await completeWorkflowIssueStepRunsAfterDone({
        db: tx,
        issue: updated,
        completedAt: updated.completedAt ?? new Date(),
        source: workflowSyncSource,
      });
    }
    if (nextLabelIds !== undefined) {
      await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
    }
    const [enriched] = await withIssueLabels(tx, [updated]);
    return enriched;
  });

  const executionCardInputChanged = (
    (issueData.title !== undefined && issueData.title !== existing.title) ||
    (issueData.description !== undefined && issueData.description !== existing.description) ||
    (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
    (issueData.projectId !== undefined && issueData.projectId !== existing.projectId) ||
    (issueData.missionId !== undefined && issueData.missionId !== existing.missionId)
  );
  if (updatedIssue && executionCardInputChanged) {
    try {
      await resyncIssueExecutionCardAfterIssueUpdate({ db, issue: updatedIssue });
    } catch (err) {
      logger.warn({ err, issueId: updatedIssue.id }, "failed to resync issue execution card after issue update");
    }
  }

  if (
    updatedIssue &&
    issueData.status &&
    issueData.status !== existing.status &&
    (issueData.status === "done" || issueData.status === "blocked" || issueData.status === "cancelled")
  ) {
    try {
      await persistTerminalIssueHandoff({
        db,
        issue: updatedIssue,
        previousIssue: existing,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: updatedIssue.id, status: issueData.status },
        "failed to persist terminal issue handoff",
      );
    }
    try {
      const { finalizeDelegatedWorkflowTargetIssue } = await import("./workflow-delegations.js");
      await finalizeDelegatedWorkflowTargetIssue(db, {
        targetIssueId: updatedIssue.id,
        targetStatus: issueData.status,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: updatedIssue.id, status: issueData.status },
        "failed to finalize delegated workflow target issue",
      );
    }
  }

  if (updatedIssue && issueData.status && issueData.status !== existing.status) {
    try {
      const { workflowService } = await import("./workflow/engine.js");
      await workflowService.syncRunStatusForIssue(db, updatedIssue.id, workflowSyncSource);
    } catch (err) {
      logger.warn(
        { err, issueId: updatedIssue.id, status: issueData.status },
        "failed to sync workflow state after issue status update",
      );
    }
  }

  return updatedIssue;
}
