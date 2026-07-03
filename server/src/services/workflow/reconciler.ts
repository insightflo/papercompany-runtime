/**
 * Workflow Reconciler
 *
 * Handles automatic reconciliation of workflow state after failures or interruptions.
 * Replaces PluginContext with direct database access via Drizzle.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { eq, and, gt, inArray, like, lt, sql } from "drizzle-orm";
import { logger as defaultLogger } from "../../middleware/logger.js";
// Reused edge logic: the deadlock gate must answer the SAME reachability question
// the launcher/dag-engine answers ("is this pending step runnable given predecessor
// facts?"). The pure leaf classifier is imported rather than re-derived so the gate
// never diverges from the launcher's view of the DAG.
import { classifyStepActivation, workflowHasConditionalEdges, type PredFacts, type PredStatus } from "./control-flow/edge-condition.js";
import {
  buildWorkflowExecutionSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  wakeExistingWorkflowStepIssue,
  type WorkflowStep,
} from "./dag-engine.js";

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
      // [P7] native control-flow loop 가 iterating 중(iteration_index>0)이면 stuck kill 면제.
      // 루프는 maxIterations cap 으로 자기 종료하므로 60min reconciler kill 의 대상이 아니다.
      // (루프 반복 사이에 순간적으로 active step/issue 가 없는 찰나에 kill 이 발화하지 않게.)
      const iteratingStep = await db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(and(
          eq(workflowStepRuns.workflowRunId, run.id),
          gt(workflowStepRuns.iterationIndex, 0),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (iteratingStep) {
        results.push({
          runId: run.id,
          action: "skipped",
          reason: "Native control-flow loop iterating (iteration_index > 0); bounded by maxIterations",
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
// Deadlock fast-path marker for idempotent block comments.
const DEADLOCK_COMMENT_MARKER = "control-plane-deadlock";

// Mirrors of dag-engine's private buildStepRunMap / buildPredFactsMap. Imported
// here as local adapters so the reconciler does not depend on dag-engine's
// private function surface; the actual edge/reachability math is reused via
// classifyStepActivation (imported above). isQaGate is left false because the
// forward reachability gate (classifyStepActivation) excludes back-edges, so
// qa_request_changes verdict handling never affects the deadlock decision here;
// the in_review guard below still covers QA-back-edge recovery conservatively.
function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, (typeof workflowStepRuns.$inferSelect)> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

function buildPredFactsMap(
  steps: WorkflowStep[],
  stepRunMap: Map<string, (typeof workflowStepRuns.$inferSelect)>,
): Map<string, PredFacts> {
  const facts = new Map<string, PredFacts>();
  for (const step of steps) {
    const run = stepRunMap.get(step.id);
    facts.set(step.id, {
      status: (run?.status ?? "pending") as PredStatus,
      isQaGate: false,
      verdict: null,
      verdictChecked: false,
    });
  }
  return facts;
}

export async function reconcileRunnableWorkflowStepWakeups(
  db: Db,
  settlingMinutes: number = 5,
): Promise<ReconciliationResult[]> {
  const settlingCutoff = new Date(Date.now() - settlingMinutes * 60 * 1000);
  const candidates = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), lt(workflowRuns.startedAt, settlingCutoff)));

  const results: ReconciliationResult[] = [];

  for (const run of candidates) {
    try {
      const iterating = await db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(and(eq(workflowStepRuns.workflowRunId, run.id), gt(workflowStepRuns.iterationIndex, 0)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (iterating) continue;

      const runSteps = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, run.id));
      const pending = runSteps.filter((step) => step.status === "pending" && step.issueId);
      if (pending.length === 0) continue;

      const definition = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!definition) continue;

      const steps = buildWorkflowExecutionSteps(definition);
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const stepRunMap = buildStepRunMap(runSteps);
      const predsByStepId = buildPredFactsMap(steps, stepRunMap);
      const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition({
        name: definition.name,
        executionMode: definition.executionMode,
        dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
        steps,
      });
      const launchStepIds = dynamicOwnerPlan
        ? new Set(getWorkflowLaunchSteps(steps, { dynamicOwnerPlan }).map((step) => step.id))
        : undefined;

      const linkedIssueIds = pending
        .map((step) => step.issueId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const linkedIssueRows = linkedIssueIds.length > 0
        ? await db
          .select({ id: issues.id, status: issues.status })
          .from(issues)
          .where(inArray(issues.id, linkedIssueIds))
        : [];
      const issueStatusById = new Map(linkedIssueRows.map((issue) => [issue.id, issue.status]));

      for (const stepRun of pending) {
        if (!stepRun.issueId) continue;
        if (issueStatusById.get(stepRun.issueId) !== "todo") continue;
        const step = stepById.get(stepRun.stepId);
        if (!step) continue;
        if (launchStepIds && !launchStepIds.has(step.id)) continue;
        if (!classifyStepActivation(step, predsByStepId).runnable) continue;

        const activeHeartbeat = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.issueId, stepRun.issueId),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (activeHeartbeat) continue;

        const activeWakeup = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, run.companyId),
            eq(agentWakeupRequests.issueId, stepRun.issueId),
            eq(agentWakeupRequests.workflowRunId, run.id),
            inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (activeWakeup) continue;

        const queued = await wakeExistingWorkflowStepIssue({
          db,
          run,
          definition,
          step,
          issueId: stepRun.issueId,
        });
        if (queued) {
          results.push({
            runId: run.id,
            action: "recovered",
            reason: `Queued missing workflow_resume wakeup for runnable step ${stepRun.stepId}`,
          });
        }
      }
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
 * Reconciles workflow runs that are deadlocked WITHOUT waiting for the 60-min
 * stuck-run timeout: a running run with NO active step execution, NO iterating
 * loop, at least one FAILED predecessor, and remaining PENDING steps that can
 * never become runnable.
 *
 * EDGE-AWARE GATE (the core correctness invariant): a pending step is only
 * unreachable when its dependency closure includes a failed/terminal-failed
 * predecessor. The gate reuses classifyStepActivation (the same edge math the
 * launcher uses) so that an INDEPENDENT parallel branch whose predecessors are
 * satisfied is never skipped/blocked. If ANY pending step is still runnable the
 * run is NOT deadlocked and is left untouched.
 *
 * Conservative: skips runs with any in_review issue (a QA back-edge could still
 * recover the failed predecessor). Pending issue-less steps -> skipped with the
 * controlFlowSkipped sentinel. Pending steps linked to an issue -> skipped
 * sentinel + the issue is blocked with one idempotent comment (never
 * failed/done/cancelled: it never ran).
 */
export async function reconcileDeadlockedWorkflowRuns(
  db: Db,
  settlingMinutes: number = 5,
): Promise<ReconciliationResult[]> {
  // Settling gate: a run must be older than a few minutes so the launcher has had
  // time to pick up any reachable todo step. Much shorter than the 60-min stuck gate,
  // but avoids racing a freshly-created run whose first todo has not launched yet.
  const settlingCutoff = new Date(Date.now() - settlingMinutes * 60 * 1000);
  const candidates = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        lt(workflowRuns.startedAt, settlingCutoff),
      ),
    );

  const results: ReconciliationResult[] = [];

  for (const run of candidates) {
    // Per-run isolation: a comment/update failure on one run must not abort the
    // whole loop (and thus reconcileWorkflow + stuck/orphan cleanup running in the
    // same tick). Log the failed run and continue with the next candidate.
    try {
      // Skip native control-flow loops mid-iteration (bounded by maxIterations).
      const iterating = await db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(and(eq(workflowStepRuns.workflowRunId, run.id), gt(workflowStepRuns.iterationIndex, 0)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (iterating) continue;

      // A genuinely-executing step (running step, in_progress/in_review issue, or
      // queued/running heartbeat). A mere 'todo' issue does NOT count as active here:
      // an unreachable todo is the deadlock symptom, not progress.
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
                  AND ${issues.status} IN ('in_progress', 'in_review')
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
      if (activeStep) continue;

      const runSteps = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, run.id));
      const pending = runSteps.filter((step) => step.status === "pending");
      const hasFailedPredecessor = runSteps.some((step) => step.status === "failed");
      if (pending.length === 0 || !hasFailedPredecessor) continue;

      const linkedIssueIds = pending
        .map((step) => step.issueId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const linkedIssueRows = linkedIssueIds.length > 0
        ? await db
          .select({ id: issues.id, status: issues.status })
          .from(issues)
          .where(inArray(issues.id, linkedIssueIds))
        : [];
      if (linkedIssueRows.some((issue) => issue.status === "in_review")) continue;
      const issueStatusById = new Map(linkedIssueRows.map((issue) => [issue.id, issue.status]));

      const definition = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!definition) continue; // No definition to classify edges -> defer to normal flow.

      const steps = buildWorkflowExecutionSteps(definition);
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const stepRunMap = buildStepRunMap(runSteps);
      const predsByStepId = buildPredFactsMap(steps, stepRunMap);
      const hasConditionalEdges = workflowHasConditionalEdges(steps);
      const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition({
        name: definition.name,
        executionMode: definition.executionMode,
        dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
        steps,
      });
      const launchStepIds = dynamicOwnerPlan
        ? new Set(getWorkflowLaunchSteps(steps, { dynamicOwnerPlan }).map((step) => step.id))
        : undefined;
      const hasProgressCandidate = pending.some((step) => {
        const stepDef = stepById.get(step.stepId);
        if (!stepDef) return true;
        if (!classifyStepActivation(stepDef, predsByStepId).runnable) return false;
        if (step.issueId) return issueStatusById.get(step.issueId) === "todo";
        if (launchStepIds && !launchStepIds.has(stepDef.id)) return false;
        return hasConditionalEdges;
      });
      if (hasProgressCandidate) continue;

      // Deadlock confirmed: converge immediately.
      const now = new Date();
      for (const step of pending) {
        const priorMetadata = (step.metadata as Record<string, unknown> | null) ?? {};
        await db
          .update(workflowStepRuns)
          .set({
            status: "skipped",
            completedAt: now,
            metadata: { ...priorMetadata, controlFlowSkipped: true },
          })
          .where(eq(workflowStepRuns.id, step.id));
        if (step.issueId) {
          await blockIssueOnDeadlock(db, {
            issueId: step.issueId,
            companyId: run.companyId,
            runId: run.id,
            stepId: step.id,
          });
        }
      }

      await db
        .update(workflowRuns)
        .set({ status: "failed", completedAt: now })
        .where(eq(workflowRuns.id, run.id));

      results.push({
        runId: run.id,
        action: "recovered",
        reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
      });
    } catch (error) {
      // One deadlocked run's comment/update error must not abort the loop (nor the
      // stuck/orphan cleanup running in the same reconcileWorkflow tick). The run
      // stays running and is retried next tick.
      results.push({
        runId: run.id,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// Blocks an issue reached by a workflow deadlock and posts ONE idempotent comment.
// Idempotency: a bracketed marker keyed by (runId, stepId); skip if already blocked
// or a comment with the marker already exists. Never marks failed/done/cancelled.
async function blockIssueOnDeadlock(
  db: Db,
  input: { issueId: string; companyId: string; runId: string; stepId: string },
) {
  const marker = `[${DEADLOCK_COMMENT_MARKER}:${input.runId}:${input.stepId}]`;
  const issue = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) return;
  if (issue.status === "blocked" || issue.status === "done" || issue.status === "cancelled") return;

  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, input.issueId), like(issueComments.body, `%${marker}%`)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return;

  const now = new Date();
  await db
    .update(issues)
    .set({ status: "blocked", updatedAt: now })
    .where(eq(issues.id, input.issueId));
  await db.insert(issueComments).values({
    id: randomUUID(),
    companyId: input.companyId,
    issueId: input.issueId,
    authorUserId: null,
    body: `unreachable: upstream step failed; replan or cancel ${marker}`,
    createdAt: now,
    updatedAt: now,
  });
}

export async function reconcileWorkflow(
  db: Db,
  options: { timeoutMinutes?: number } = {},
): Promise<{
    runnableStepWakeupsQueued: number;
    deadlockedRunsRecovered: number;
    stuckRunsRecovered: number;
    orphanStepsCleaned: number;
  }> {
  const timeoutMinutes = options.timeoutMinutes ?? 60;

  const runnableWakeupResults = await reconcileRunnableWorkflowStepWakeups(db);
  const deadlockedResults = await reconcileDeadlockedWorkflowRuns(db);
  const stuckResults = await reconcileStuckWorkflowRuns(db, timeoutMinutes);
  const orphanStepsCleaned = await reconcileOrphanStepRuns(db);

  return {
    runnableStepWakeupsQueued: runnableWakeupResults.filter((r) => r.action === "recovered").length,
    deadlockedRunsRecovered: deadlockedResults.filter((r) => r.action === "recovered").length,
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
  lastRunnableStepWakeupsQueued: number;
  lastDeadlockedRunsRecovered: number;
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
  let lastRunnableStepWakeupsQueued = 0;
  let lastDeadlockedRunsRecovered = 0;
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
      lastRunnableStepWakeupsQueued = result.runnableStepWakeupsQueued;
      lastDeadlockedRunsRecovered = result.deadlockedRunsRecovered;
      lastStuckRunsRecovered = result.stuckRunsRecovered;
      lastOrphanStepsCleaned = result.orphanStepsCleaned;
      lastError = null;
      if (
        result.runnableStepWakeupsQueued > 0
        || result.deadlockedRunsRecovered > 0
        || result.stuckRunsRecovered > 0
        || result.orphanStepsCleaned > 0
      ) {
        log.info(
          {
            timeoutMinutes,
            runnableStepWakeupsQueued: result.runnableStepWakeupsQueued,
            deadlockedRunsRecovered: result.deadlockedRunsRecovered,
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
        lastRunnableStepWakeupsQueued,
        lastDeadlockedRunsRecovered,
        lastStuckRunsRecovered,
        lastOrphanStepsCleaned,
        lastError,
      };
    },
  };
}
