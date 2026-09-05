/**
 * Workflow Reconciler
 *
 * Handles automatic reconciliation of workflow state after failures or interruptions.
 * Replaces PluginContext with direct database access via Drizzle.
 */

import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { reconcileDeadlockedWorkflowRuns } from "./deadlock-reconciler.js";
import { reconcileRunnableWorkflowStepWakeups } from "./runnable-step-wakeups-reconciler.js";
import { reconcileDueWorkflowStepRetries, isStepRunAwaitingRetry } from "./retry-reconciler.js";
import { reconcileGraceWaitingControlNodes } from "./grace-waiting-control-node-reconciler.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";

export { reconcileDeadlockedWorkflowRuns } from "./deadlock-reconciler.js";
export {
  createNativeWorkflowReconciler,
  type CreateNativeWorkflowReconcilerOptions,
  type NativeWorkflowReconciler,
  type NativeWorkflowReconcilerLogger,
  type NativeWorkflowReconcilerState,
} from "./native-reconciler.js";
export { reconcileRunnableWorkflowStepWakeups } from "./runnable-step-wakeups-reconciler.js";
export { reconcileGraceWaitingControlNodes } from "./grace-waiting-control-node-reconciler.js";
export { reconcileDueWorkflowStepRetries } from "./retry-reconciler.js";

/**
 * Reconciliation result for a single workflow run.
 */
export interface ReconciliationResult {
  runId: string;
  action: "recovered" | "failed" | "skipped";
  reason?: string;
}

/**
 * Reconciles all stuck workflow runs.
 *
 * [주의] stuck 판정은 status='running' 이고 startedAt 이 (now - timeoutMinutes) 보다
 *        오래된 run. workflow_runs 에 updatedAt 이 없어 startedAt(시작시각) 기준이다.
 *        정상 진행 중이더라도 시작 후 timeoutMinutes(기본 60분)가 넘은 장기 워크플로우는
 *        stuck 으로 오판되어 force-fail 될 수 있으니, 장기 실행 워크플로우가 있다면
 *        timeoutMinutes 를 늘리거나 step/heartbeat 기반 판정으로 고도화할 것.
 *
 * @param db - Database instance.
 * @param timeoutMinutes - Timeout in minutes before considering a run stuck.
 * @returns List of reconciliation results.
 */
export async function reconcileStuckWorkflowRuns(
  db: Db,
  timeoutMinutes: number = 60,
): Promise<ReconciliationResult[]> {
  const timeout = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const stuckRuns = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        lt(workflowRuns.startedAt, timeout),
      ),
    );

  const results: ReconciliationResult[] = [];

  for (const run of stuckRuns) {
    try {
      if (await hasActiveWorkflowReworkIteration(db, {
        companyId: run.companyId,
        workflowRunId: run.id,
      })) {
        results.push({
          runId: run.id,
          action: "skipped",
          reason: "Native control-flow rework iteration is actively executing",
        });
        continue;
      }

      const activeStep = await db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, run.id),
            sql`(
              ${workflowStepRuns.status} = 'running'
              OR EXISTS (
                SELECT 1 FROM ${issues}
                WHERE ${issues.id} = ${workflowStepRuns.issueId}
                  AND ${issues.status} IN ('todo', 'in_progress', 'in_review')
              )
              OR EXISTS (
                SELECT 1 FROM ${heartbeatRuns}
                WHERE ${heartbeatRuns.issueId} = ${workflowStepRuns.issueId}
                  AND ${heartbeatRuns.status} IN ('queued', 'running')
              )
            )`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (activeStep) {
        results.push({
          runId: run.id,
          action: "skipped",
          reason: "Active workflow step execution is still running",
        });
        continue;
      }

      // Check if any step runs are still pending
      const pendingSteps = await db
        .select()
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, run.id),
            eq(workflowStepRuns.status, "pending"),
          ),
        );

      if (pendingSteps.length > 0) {
        const normalizeMetadata = (m: unknown): Record<string, unknown> =>
          m && typeof m === "object" && !Array.isArray(m)
            ? (m as Record<string, unknown>)
            : {};
        // [finding 2] If ANY pending step has a valid live workflow retry
        // (waiting future/due or dispatching), the run has automatic
        // continuation. Leave the ENTIRE run running and skip NO step —
        // neither the retry step nor its pending siblings — and do not mark
        // the run failed. Human Operator terminal reporting stays suppressed.
        if (pendingSteps.some((step) => isStepRunAwaitingRetry(normalizeMetadata(step.metadata)))) {
          results.push({
            runId: run.id,
            action: "skipped",
            reason: "Workflow run has a live workflow retry in progress",
          });
          continue;
        }
        const now = new Date();
        for (const step of pendingSteps) {
          const metadata = normalizeMetadata(step.metadata);
          const [updated] = await db
            .update(workflowStepRuns)
            .set({
              status: "skipped",
              completedAt: now,
              metadata: {
                ...metadata,
                failureCascadeSkipped: true,
              },
            })
            .where(eq(workflowStepRuns.id, step.id))
            .returning({
              id: workflowStepRuns.id,
              transitionVersion: workflowStepRuns.statusTransitionVersion,
            });
          if (updated) {
            await recordWorkflowStepStatusTransition(db, {
              companyId: run.companyId,
              missionId: run.missionId,
              workflowRunId: run.id,
              workflowStepRunId: step.id,
              issueId: step.issueId,
              fromStatus: step.status,
              toStatus: "skipped",
              source: "workflow_reconciler",
              transitionVersion: updated.transitionVersion > step.statusTransitionVersion
                ? updated.transitionVersion
                : null,
            });
          }
        }
      }

      // Mark the run as failed
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));

      results.push({
        runId: run.id,
        action: "recovered",
        reason: "Marked stuck run as failed",
      });
    } catch (error) {
      results.push({
        runId: run.id,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Reconciles orphan workflow step runs (step runs without a valid workflow run).
 *
 * @param db - Database instance.
 * @returns Number of orphan step runs cleaned up.
 */
export async function reconcileOrphanStepRuns(db: Db): Promise<number> {
  // [주의] "orphan" 은 참조 run 이 실제로 존재하지 않는(삭제된) step_run 만 해당한다.
  // 과거 구현은 terminal(completed/failed/cancelled) run 의 step_run 까지 함께 DELETE 해
  // 매 run 종료 시 정상 step 기록이 전부 사라지는(workflow_step_runs 가 비어버리는) 회귀가 있었다.
  // workflow_step_runs.workflow_run_id 는 onDelete:cascade FK 라 run 삭제 시 step_run 은 이미
  // 자동 삭제되므로, 여기서 잡아야 할 진짜 orphan 는 cascade 를 벗어난 dangling 뿐이다.
  const orphanStepRuns = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(sql`
      NOT EXISTS (
        SELECT 1 FROM ${workflowRuns}
        WHERE ${workflowRuns.id} = ${workflowStepRuns.workflowRunId}
      )
    `);

  let cleaned = 0;
  for (const stepRun of orphanStepRuns) {
    try {
      await db
        .delete(workflowStepRuns)
        .where(eq(workflowStepRuns.id, stepRun.id));
      cleaned++;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      // A concurrent cleanup can make a single orphan delete fail; keep scanning.
    }
  }

  return cleaned;
}

/**
 * Full reconciliation workflow.
 *
 * Runs all reconciliation checks and returns a summary.
 *
 * @param db - Database instance.
 * @param options - Reconciliation options.
 */
export async function reconcileWorkflow(
  db: Db,
  options: { timeoutMinutes?: number } = {},
): Promise<{
    retryReconciliationsReleased: number;
    runnableStepWakeupsQueued: number;
    deadlockedRunsRecovered: number;
    stuckRunsRecovered: number;
    orphanStepsCleaned: number;
    graceWaitingControlNodesReevaluated: number;
  }> {
  const timeoutMinutes = options.timeoutMinutes ?? 60;

  const retryResults = await reconcileDueWorkflowStepRetries(db);
  const runnableWakeupResults = await reconcileRunnableWorkflowStepWakeups(db);
  const deadlockedResults = await reconcileDeadlockedWorkflowRuns(db);
  const stuckResults = await reconcileStuckWorkflowRuns(db, timeoutMinutes);
  const orphanStepsCleaned = await reconcileOrphanStepRuns(db);
  const graceWaitResults = await reconcileGraceWaitingControlNodes(db);

  return {
    retryReconciliationsReleased: retryResults.filter((r) => r.action === "recovered").length,
    runnableStepWakeupsQueued: runnableWakeupResults.filter((r) => r.action === "recovered").length,
    deadlockedRunsRecovered: deadlockedResults.filter((r) => r.action === "recovered").length,
    stuckRunsRecovered: stuckResults.filter((r) => r.action === "recovered").length,
    orphanStepsCleaned,
    graceWaitingControlNodesReevaluated: graceWaitResults.filter((r) => r.action === "recovered").length,
  };
}
