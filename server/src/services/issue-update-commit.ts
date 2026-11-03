import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { getProjectDefaultGoalId, syncIssueLabels, type IssueWriteDb } from "./issue-create-records.js";
import { resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import { logger } from "../middleware/logger.js";
import { resyncIssueExecutionCardAfterIssueUpdate } from "./issue-execution-cards/resync.js";
import { persistTerminalIssueHandoff } from "./missions/issue-terminal-handoff.js";
import { closeLockedOwnerHumanSettlements, lockSourceOwnerHumanSettlement } from "./missions/mission-work-settlement.js";
import { completeWorkflowIssueStepRunsAfterDone } from "./workflow/work-product-completion-gate.js";
import type { WorkflowSyncSource } from "./workflow/workflow-sync-source.js";
import { freezeHeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import { createTerminalReleaseManifest, readTerminalReleaseManifestForSource, terminalReleaseMatchesRun,
  writeTerminalReleaseManifest, type TerminalReleaseManifest } from "./heartbeat-terminal-release-continuation.js";

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

type TerminalOwnerRelease = { heartbeatRunId: string; manifest: TerminalReleaseManifest };
const ownerReleaseHeld = (reason: string): never => {
  throw conflict(`terminal_issue_owner_release_unproven:${reason}`, { reason });
};

/** Freeze the exact workflow owner before public completion clears its owner columns. */
async function readTerminalOwnerRelease(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], issue: IssueRow):
Promise<TerminalOwnerRelease | null> {
  const workflowIssue = issue.originKind === "workflow_execution" || issue.missionId !== null;
  const owners = [issue.executionRunId, issue.checkoutRunId].filter((value): value is string => value !== null);
  if (new Set(owners).size > 1) return workflowIssue ? ownerReleaseHeld("owner_columns_disagree") : null;
  const heartbeatRunId = owners[0];
  if (!heartbeatRunId) return null;

  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, heartbeatRunId), eq(heartbeatRuns.companyId, issue.companyId),
  )).for("update");
  if (!run) return workflowIssue ? ownerReleaseHeld("owner_run_missing") : null;
  const workflowLinked = run.workflowStepRunId !== null || run.workflowExecutionGeneration !== null
    || run.executionScopeKind === "workflow_step" || issue.originKind === "workflow_execution";
  if (!workflowLinked) return null;
  if (!issue.missionId || !run.issueId || run.issueId !== issue.id || run.agentId !== issue.assigneeAgentId
    || !run.workflowStepRunId || run.workflowExecutionGeneration === null || !run.wakeupRequestId
    || issue.executionRunId !== null && issue.executionRunId !== run.id
    || issue.checkoutRunId !== null && issue.checkoutRunId !== run.id) {
    return ownerReleaseHeld("original_owner_scope_mismatch");
  }

  const [step] = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, run.workflowStepRunId)).for("share");
  if (!step || step.issueId !== issue.id || step.executionGeneration !== run.workflowExecutionGeneration
    || step.retryCount === null || step.iterationIndex === null) return ownerReleaseHeld("workflow_step_attempt_missing");
  if (step.dispatchOwnerHeartbeatRunId !== run.id || step.dispatchOwnerWakeupRequestId !== run.wakeupRequestId) {
    return ownerReleaseHeld("dispatch_owner_changed");
  }
  const [workflow] = await tx.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, step.workflowRunId), eq(workflowRuns.companyId, issue.companyId),
  )).for("share");
  const [wake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, issue.companyId),
  )).for("share");
  if (!workflow || !wake || workflow.missionId !== issue.missionId || wake.runId !== run.id
    || wake.agentId !== run.agentId || wake.issueId !== issue.id || wake.missionId !== issue.missionId
    || wake.workflowRunId !== workflow.id || wake.workflowStepRunId !== step.id
    || wake.workflowExecutionGeneration !== step.executionGeneration) return ownerReleaseHeld("source_authority_mismatch");

  const identity = await freezeHeartbeatActualDrainIdentity(tx, run, { workflowRunId: workflow.id });
  if (!identity || identity.companyId !== issue.companyId || identity.missionId !== issue.missionId
    || identity.workflowRunId !== workflow.id || identity.dispatchAuthorityVersion !== workflow.dispatchAuthorityVersion
    || identity.workflowStepRunId !== step.id || identity.stepId !== step.stepId || identity.issueId !== issue.id
    || identity.heartbeatRunId !== run.id || identity.wakeupRequestId !== wake.id
    || identity.executionGeneration !== step.executionGeneration || identity.retryCount !== step.retryCount
    || identity.iterationIndex !== step.iterationIndex) return ownerReleaseHeld("frozen_actual_identity_unproven");

  const manifest = createTerminalReleaseManifest(identity, run.agentId, [
    { stage: "issue_promotion", action: { kind: "promote_issue_wakes", companyId: issue.companyId, issueId: issue.id } },
    { stage: "issue_promotion", action: { kind: "promote_agent_queue", companyId: issue.companyId, agentId: run.agentId } },
    { stage: "workflow_evidence_sync", action: { kind: "sync_issue", companyId: issue.companyId, issueId: issue.id } },
    { stage: "workflow_evidence_sync", action: { kind: "reevaluate_source" } },
  ]);
  if (!terminalReleaseMatchesRun(manifest.source, run)) return ownerReleaseHeld("frozen_actual_run_mismatch");
  const prior = await readTerminalReleaseManifestForSource(tx, identity, run.agentId);
  if (prior.kind !== "absent") return ownerReleaseHeld(prior.kind === "held"
    ? `prior_manifest_${prior.reason}` : "manifest_preexists_before_owner_clear");
  return { heartbeatRunId: run.id, manifest };
}

async function lockAndVerifyIssueOwnerSnapshot(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], issue: IssueRow) {
  const [current] = await tx.select().from(issues).where(and(
    eq(issues.companyId, issue.companyId), eq(issues.id, issue.id),
  )).for("update");
  if (!current || current.status !== issue.status || current.missionId !== issue.missionId
    || current.originKind !== issue.originKind || current.originId !== issue.originId || current.originRunId !== issue.originRunId
    || current.assigneeAgentId !== issue.assigneeAgentId || current.executionRunId !== issue.executionRunId
    || current.checkoutRunId !== issue.checkoutRunId || current.executionAgentNameKey !== issue.executionAgentNameKey
    || current.executionLockedAt?.getTime() !== issue.executionLockedAt?.getTime()) {
    ownerReleaseHeld("source_issue_owner_snapshot_changed");
  }
}

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
    const terminalOwnerRelease = issueData.status === "done" && existing.status !== "done"
      ? await readTerminalOwnerRelease(tx, existing) : null;
    const ownerHuman = existing.missionId && issueData.status !== existing.status
      && (issueData.status === "done" || issueData.status === "cancelled")
      ? await lockSourceOwnerHumanSettlement(tx, { companyId: existing.companyId,
        missionId: existing.missionId, sourceIssueId: existing.id }) : null;
    if (terminalOwnerRelease) await lockAndVerifyIssueOwnerSnapshot(tx, existing);
    const updated = await tx
      .update(issues)
      .set(patch)
      .where(eq(issues.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    if (terminalOwnerRelease) {
      if (updated.id !== existing.id || updated.companyId !== existing.companyId
        || updated.missionId !== terminalOwnerRelease.manifest.source.missionId
        || updated.assigneeAgentId !== terminalOwnerRelease.manifest.source.agentId
        || updated.executionRunId !== null || updated.checkoutRunId !== null
        || updated.executionAgentNameKey !== null || updated.executionLockedAt !== null) {
        ownerReleaseHeld("owner_clear_result_mismatch");
      }
      await writeTerminalReleaseManifest(tx, terminalOwnerRelease.manifest);
    }
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
