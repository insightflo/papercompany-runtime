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
import { hasLiveWorkflowChildWait, reconcileWorkflowChildStepWaits } from "./workflow-child-execution.js";
import { reconcileUnmaterializedChildStartTimeout } from "./workflow-child-start-recovery-timeout.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import {
  isChildStartContention,
  isChildStartDatabaseTimeout,
} from "./workflow-child-start-contention.js";
// [run-terminal-boundary v1] stuck 강제 종결의 경계 우회 + 커밋 후 부작용 즉시 실행(플래그 게이팅은 호출자 책임).
import { evaluateRecoveryChannels, executeTerminalEffectIntents, finalizeRunTerminal } from "./run-terminal-boundary.js";
import { isRunTerminalBoundaryV1Enabled } from "./run-terminal-boundary-flag.js";

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
export { reconcileWorkflowChildStepWaits } from "./workflow-child-execution.js";
export { reconcileDueWorkflowStepRetries } from "./retry-reconciler.js";

/**
 * Reconciliation result for a single workflow run.
 */
export interface ReconciliationResult {
  runId: string;
  action: "recovered" | "failed" | "skipped" | "deferred";
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
  // [run-terminal-boundary v1] 플래그는 pass 당 1회 읽는다 — legacy 경로의 추가 I/O 를 이 한 번으로 제한한다.
  const boundaryEnabled = await isRunTerminalBoundaryV1Enabled(db);

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
      // [descope v1] 링크 자식 분기는 전용 모듈이 분류한다 — 자체 변이는 없고 커밋 결과만 보고받는다
      //   ('settled'=커밋 승리, 'skipped'=소유/경합/무효/타임아웃 양보). materialized/일반 run 은 'native'.
      const childStartTimeout = await reconcileUnmaterializedChildStartTimeout(db, {
        childRunId: run.id,
        companyId: run.companyId,
        nativeTimeoutCutoff: timeout,
      });
      if (childStartTimeout === "skipped") {
        results.push({
          runId: run.id,
          action: "skipped",
          reason: "Linked child start is owned or not yet actionable; bounded start recovery owns it",
        });
        continue;
      }
      if (childStartTimeout === "settled") {
        results.push({
          runId: run.id,
          action: "recovered",
          reason: "Unmaterialized linked child start timed out",
        });
        continue;
      }
      // 'native' — materialized 자식/일반 run. 아래의 기존 native liveness 검사로 fall through.
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

      // [run-terminal-boundary v1] 경계 종결과 선점평가가 같은 stepRun 사실을 소비한다(1회 적재).
      const boundaryStepRuns = boundaryEnabled
        ? await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
        : [];

      if (pendingSteps.length > 0) {
        const normalizeMetadata = (m: unknown): Record<string, unknown> =>
          m && typeof m === "object" && !Array.isArray(m)
            ? (m as Record<string, unknown>)
            : {};
        // [finding 2] 살아있는 자동 재시도(waiting/dispatching)가 있는 run 은 통째로 진행 중 —
        // 어떤 스텝도 skip 하지 않고 run failed 도 금지. Operator 보고는 억제된다.
        // [workflow child step] pending 스텝 중 하나라도 자식 run 대기가 있으면 동일(fix round P1-7).
        if (pendingSteps.some((step) => isStepRunAwaitingRetry(normalizeMetadata(step.metadata)))) {
          results.push({ runId: run.id, action: "skipped", reason: "Workflow run has a live workflow retry in progress" });
          continue;
        }
        const liveChildWaits = await Promise.all(
          pendingSteps.map((step) => hasLiveWorkflowChildWait(db, step)),
        );
        if (liveChildWaits.some(Boolean)) {
          results.push({ runId: run.id, action: "skipped", reason: "Workflow run has live workflow child step waits in progress" });
          continue;
        }
        // [run-terminal-boundary v1] 스텝 skip "전" 회복 채널 선점평가 — 열/불명이면 그 외 어떤
        //   행도 쓰지 않고 유예한다(계약: 유예 시 그 외 어떤 행도 쓰지 않는다).
        if (boundaryEnabled) {
          const precheck = await evaluateRecoveryChannels(db, {
            runId: run.id,
            companyId: run.companyId,
            missionId: run.missionId,
            stepRuns: boundaryStepRuns,
            now: new Date(),
          });
          if (precheck.kind !== "clear") {
            const evidenceSummary = precheck.kind === "open"
              ? precheck.evidence.map((item) => `${item.channel}:${item.targetId}`).join(",")
              : `unknown:${precheck.error ?? "?"}`;
            results.push({
              runId: run.id,
              action: "deferred",
              reason: `Recovery channel open/unknown; finalization deferred (${evidenceSummary})`,
            });
            continue;
          }
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

      if (boundaryEnabled) {
        // [run-terminal-boundary v1] stuck 강제 종결을 경계로 우한다 — CAS/원인 스탬프/회복 게이트는
        //   코어 계약이 소유한다. 최종 재평가에서 채널이 열리면 유예되어 run 은 비종말로 남는다.
        const boundary = await finalizeRunTerminal(db, {
          runId: run.id,
          companyId: run.companyId,
          expectedAuthorityVersion: run.dispatchAuthorityVersion,
          decision: "failed",
          cause: {
            policy: "recovery_deadline_hard",
            discovery: "stuck_diagnostic",
            origin: "reconciler",
            reason: "Marked stuck run as failed",
          },
          gatePolicy: "defer_on_open_recovery",
          now: new Date(),
          stepRuns: boundaryStepRuns,
        });
        if (boundary.kind === "deferred") {
          results.push({ runId: run.id, action: "deferred", reason: "Recovery channel opened during finalization; steps skipped, run left non-terminal" });
          continue;
        }
        if (boundary.kind === "stale_authority") {
          results.push({ runId: run.id, action: "skipped", reason: "Run authority superseded; stuck finalization discarded" });
          continue;
        }
        if (boundary.kind === "already_finalized") {
          results.push({ runId: run.id, action: "skipped", reason: "Run already terminal" });
          continue;
        }
        let effectNote = "";
        try {
          await executeTerminalEffectIntents(db, boundary.decisionId);
        } catch (error) {
          // 부작용 실행 실패는 관측 사항 — pending 인텐트는 periodic sweep 이 재처리한다(계약).
          effectNote = ` (effect execution deferred to sweep: ${error instanceof Error ? error.message : String(error)})`;
        }
        results.push({
          runId: run.id,
          action: "recovered",
          reason: `Marked stuck run as failed (terminal decision ${boundary.decisionId})${effectNote}`,
        });
        continue;
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
      // [설계 §3] 경합(55P03/40P01/40001)은 실패가 아니다 — bounded skipped, 실행 행 무변경.
      // 57014 는 타임아웃 진단 — 회복/실패 정산 근거로 쓰지 않고 skipped 로 양보한다.
      if (isChildStartContention(error) || isChildStartDatabaseTimeout(error)) {
        results.push({
          runId: run.id,
          action: "skipped",
          reason: "stuck pass lost a lock race or hit a statement timeout; execution rows unchanged",
        });
        continue;
      }
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
  // [주의] orphan 은 참조 run 이 삭제된 dangling step_run 만 해당(cascade 밖). 과거엔 terminal
  //   run 의 step_run 까지 DELETE 해 기록이 사라지는 회귀가 있었다.
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
    workflowChildWaitsReconciled: number;
  }> {
  const timeoutMinutes = options.timeoutMinutes ?? 60;

  const retryResults = await reconcileDueWorkflowStepRetries(db);
  const runnableWakeupResults = await reconcileRunnableWorkflowStepWakeups(db);
  const deadlockedResults = await reconcileDeadlockedWorkflowRuns(db);
  // [workflow child step] stuck-run 회복 "이전"에 자식 대기 회복을 실행한다(fix round P1-7):
  //   방금 종말한 자식은 stuck force-fail 보다 먼저 completion 으로 치유된다.
  const workflowChildWaitResults = await reconcileWorkflowChildStepWaits(db);
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
    workflowChildWaitsReconciled: workflowChildWaitResults.filter((r) => r.action === "recovered").length,
  };
}
