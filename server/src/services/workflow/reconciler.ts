/**
 * Workflow Reconciler
 *
 * Handles automatic reconciliation of workflow state after failures or interruptions.
 * Replaces PluginContext with direct database access via Drizzle.
 */

import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { logger as defaultLogger } from "../../middleware/logger.js";

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
        // Mark pending steps as failed
        for (const step of pendingSteps) {
          await db
            .update(workflowStepRuns)
            .set({ status: "failed", completedAt: new Date() })
            .where(eq(workflowStepRuns.id, step.id));
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
    } catch {
      // Skip if delete fails
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
    stuckRunsRecovered: number;
    orphanStepsCleaned: number;
  }> {
  const timeoutMinutes = options.timeoutMinutes ?? 60;

  const stuckResults = await reconcileStuckWorkflowRuns(db, timeoutMinutes);
  const orphanStepsCleaned = await reconcileOrphanStepRuns(db);

  return {
    stuckRunsRecovered: stuckResults.filter((r) => r.action === "recovered").length,
    orphanStepsCleaned,
  };
}

// ===========================================================================
// Native Workflow Reconciler (주기 구동 루퍼)
// ===========================================================================

/**
 * Native Workflow Reconciler
 *
 * [목적] stuck workflow run(60분 초과 running)과 orphan step run을 주기적으로
 *        정리한다. plugin workflow-reconciler(insightflo.workflow-engine)가
 *        비활성화된 배포(native owner active)에서 유일한 정리 경로다.
 *
 * [왜 필요] 과거 reconcileStuckWorkflowRuns/reconcileWorkflow 가 dead code 였고,
 *        native-scheduler 는 claimScheduledRun 만 수행해, failed step 이후에도
 *        run 이 running 으로 방치되는 장애(최장 25시간 → retry 시 Failed to fetch)
 *        가 발생했다. 이 루퍼가 createNativeWorkflowScheduler 패턴과 동일하게
 *        setInterval + tickInFlight 가드 + unref + per-tick try/catch 로 구동한다.
 *
 * [입력] db, timeoutMinutes(기본 60), intervalMs(기본 5분), logger.
 * [출력] { start, stop, reconcile, getState }.
 * [주의] reconcileWorkflow(db) 를 감싼다. tickInFlight 로 중복 실행을 막고
 *        interval.unref() 로 이 타이머가 프로세스 종료를 막지 않게 한다.
 *        에러는 tick 단위로 catch 해 루퍼가 멈추지 않는다.
 *        멀티 인스턴스(수평확장) 시에는 reconcileStuckWorkflowRuns/reconcileOrphanStepRuns
 *        가 SELECT-then-UPDATE/DELETE 이고 행 잠금이 없어 같은 stuck run/orphan step 을
 *        동시 정리(race)할 수 있다. 단일 인스턴스 배포(A1 등)에선 안전; 다중 인스턴스는
 *        pg_advisory_xact_lock / FOR UPDATE 로 가드가 필요하다.
 * [수정시 영향] intervalMs/timeoutMinutes 변경은 stuck 감지 민감도와 정리 빈도에
 *        직결. 기본값은 reconcileStuckWorkflowRuns 의 timeout(60min)과 맞춤.
 */
export interface NativeWorkflowReconcilerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface NativeWorkflowReconcilerState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastStuckRunsRecovered: number;
  lastOrphanStepsCleaned: number;
  lastError: string | null;
}

export interface NativeWorkflowReconciler {
  start: () => void;
  stop: () => void;
  reconcile: (now?: Date) => Promise<void>;
  getState: () => NativeWorkflowReconcilerState;
}

export interface CreateNativeWorkflowReconcilerOptions {
  db: Db;
  timeoutMinutes?: number;
  intervalMs?: number;
  logger?: NativeWorkflowReconcilerLogger;
}

const DEFAULT_RECONCILER_INTERVAL_MS = 5 * 60_000;

export function createNativeWorkflowReconciler(
  options: CreateNativeWorkflowReconcilerOptions,
): NativeWorkflowReconciler {
  const intervalMs = options.intervalMs ?? DEFAULT_RECONCILER_INTERVAL_MS;
  const timeoutMinutes = options.timeoutMinutes ?? 60;
  const log = options.logger ?? defaultLogger;
  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastStuckRunsRecovered = 0;
  let lastOrphanStepsCleaned = 0;
  let lastError: string | null = null;

  async function reconcile(now = new Date()): Promise<void> {
    if (tickInFlight) {
      log.warn(
        { timeoutMinutes },
        "Native workflow reconciler tick skipped because previous tick is still running",
      );
      return;
    }
    tickInFlight = true;
    try {
      const result = await reconcileWorkflow(options.db, { timeoutMinutes });
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastStuckRunsRecovered = result.stuckRunsRecovered;
      lastOrphanStepsCleaned = result.orphanStepsCleaned;
      lastError = null;
      if (result.stuckRunsRecovered > 0 || result.orphanStepsCleaned > 0) {
        log.info(
          {
            timeoutMinutes,
            stuckRunsRecovered: result.stuckRunsRecovered,
            orphanStepsCleaned: result.orphanStepsCleaned,
          },
          "Native workflow reconciler cleaned up workflow state",
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ timeoutMinutes, err: lastError }, "Native workflow reconciler tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({ timeoutMinutes, intervalMs }, "Native workflow reconciler started");
      void reconcile();
      interval = setInterval(() => {
        void reconcile();
      }, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      log.info({ timeoutMinutes }, "Native workflow reconciler stopped");
    },
    reconcile,
    getState() {
      return {
        running: interval !== null,
        tickCount,
        lastTickAt,
        lastStuckRunsRecovered,
        lastOrphanStepsCleaned,
        lastError,
      };
    },
  };
}
