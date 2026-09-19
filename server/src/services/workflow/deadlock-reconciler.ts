import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import { classifyStepActivation, workflowHasConditionalEdges } from "./control-flow/edge-condition.js";
import {
  getWorkflowLaunchSteps,
} from "./dag-engine.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { buildPredFactsMap, buildStepRunMap } from "./reconciler-edge-helpers.js";
import type { ReconciliationResult } from "./reconciler.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import { logger } from "../../middleware/logger.js";

const DEADLOCK_COMMENT_MARKER = "control-plane-deadlock";

// [B3] 종결(terminal) 이슈 상태 — 이 상태의 연결 이슈는 회복 채널이 닫혀 있으므로 기존 deadlock
//   처리(skip + run failed 수렴)를 그대로 수행한다. 그 외(backlog/todo/in_progress/in_review/blocked 등
//   비종결)는 회복 정책상 아직 진행 가능하므로 최종 skip 확정을 보류한다(아래 hold 분기).
//   알 수 없는 상태는 fail-closed 로 비종결 취급하며, 장기 수렴은 기존 60분 stuck reconciler 가 담당한다.
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export async function reconcileDeadlockedWorkflowRuns(
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
      if (await hasActiveWorkflowReworkIteration(db, {
        companyId: run.companyId,
        workflowRunId: run.id,
      })) continue;
      if (await hasActiveWorkflowStep(db, run.id)) continue;

      const runSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
      const pending = runSteps.filter((step) => step.status === "pending");
      const hasFailedPredecessor = runSteps.some((step) => step.status === "failed");
      if (pending.length === 0 || !hasFailedPredecessor) continue;

      const linkedIssueIds = [
        ...new Set(
          [...pending, ...runSteps.filter((step) => step.status === "failed")]
            .map((step) => step.issueId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      const linkedIssueRows = linkedIssueIds.length > 0
        ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, linkedIssueIds))
        : [];
      if (linkedIssueRows.some((issue) => issue.status === "in_review")) continue;
      const issueStatusById = new Map(linkedIssueRows.map((issue) => [issue.id, issue.status]));

      const definition = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!definition) continue;

      // [task5a2b] frozen graph: launch/skip 판정은 1회 normalized snapshot 에서만 읽는다.
      //   corrupt/missing snapshot 은 아래 writes 전에 여기서 throw 되어 per-run catch 가
      //   기존 action:'failed' 결과로 수렴시킨다(row mutation 없음).
      const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
      const steps = execution.steps;
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const v1Enforcement = await isHeartbeatFinalizationV1Enabled(db);
      const predsByStepId = buildPredFactsMap(steps, buildStepRunMap(runSteps), undefined, v1Enforcement);
      const hasConditionalEdges = workflowHasConditionalEdges(steps);
      const dynamicOwnerPlan = execution.executionMode === "dynamic_owner_plan";
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

      const now = new Date();
      // [B2 좁은 회복 채널 × B3] hold 는 pending 스텝 자체의 열린 실행 이슈에 한해 적용하고, 실패
      //   선행이 이슈 기반 회복 채널(비종결 연결 이슈)을 보유한 경우엔 적용하지 않는다 — 그 채널의
      //   생사는 이미 위 rework liveness(heartbeat/wakeup) 게이트가 판정했고, 죽은 채널은 기존
      //   deadlock 수렴(skip + run failed)으로 종결한다. 이슈 없는/종결 이슈 실패만 pending 보유
      //   이슈의 회복 여지를 보존하기 위해 hold 한다(장기 수렴은 60분 stuck reconciler 담당).
      const failureSideRecoveryOpen = runSteps.some((step) => {
        if (step.status !== "failed" || !step.issueId) return false;
        const issueStatus = issueStatusById.get(step.issueId);
        return issueStatus !== undefined && !TERMINAL_ISSUE_STATUSES.has(issueStatus);
      });
      // [B3] 연결 실행 이슈가 비종결(backlog/todo/in_progress/in_review/blocked)인 pending 스텝은
      //   최종 skip 으로 확정하지 않는다 — 회복 정책상 아직 진행 가능한 스텝이므로 대기 사유를
      //   구조화 로그/결과로 남기고 pending 유지. 종결(done/cancelled) 이슈 또는 이슈 없는 스텝은
      //   기존 deadlock 처리를 유지한다(진짜 교착 수렴 보존). 이슈 행이 없는 dangling issueId 는
      //   기존 처리와 동일하게 skip 대상이다(blockIssueOnDeadlock 이 자체적으로 early-return 한다).
      const heldWaitingSteps: typeof pending = [];
      const stepsToSkip: typeof pending = [];
      for (const step of pending) {
        const linkedIssueStatus = step.issueId ? issueStatusById.get(step.issueId) : undefined;
        if (
          step.issueId
          && linkedIssueStatus !== undefined
          && !TERMINAL_ISSUE_STATUSES.has(linkedIssueStatus)
          && !failureSideRecoveryOpen
        ) {
          heldWaitingSteps.push(step);
          continue;
        }
        stepsToSkip.push(step);
      }
      if (heldWaitingSteps.length > 0) {
        const heldSummary = heldWaitingSteps
          .map((step) => `${step.stepId}#${step.issueId ? issueStatusById.get(step.issueId) ?? "missing" : "no-issue"}`)
          .join(",");
        logger.warn(
          { workflowRunId: run.id, reason: "linked_issue_non_terminal", heldSteps: heldSummary },
          "deadlock reconciler deferred final skip: pending steps still have non-terminal linked issues (waiting for recovery)",
        );
      }
      for (const step of stepsToSkip) {
        const priorMetadata = (step.metadata as Record<string, unknown> | null) ?? {};
        const [updated] = await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now, metadata: { ...priorMetadata, controlFlowSkipped: true } })
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
            source: "workflow_deadlock_reconciler",
            transitionVersion: updated.transitionVersion > step.statusTransitionVersion
              ? updated.transitionVersion
              : null,
          });
        }
        if (step.issueId) {
          await blockIssueOnDeadlock(db, {
            issueId: step.issueId,
            companyId: run.companyId,
            runId: run.id,
            stepId: step.id,
          });
        }
      }

      // [B3] 보류(hold)된 스텝이 하나라도 있으면 run 종결(final skip 수렴)도 함께 보류한다 —
      //   run failed + pending 잔존 상태(되돌림 역발생)를 만들지 않는다. 모두 수렴했을 때만 기존과
      //   동일하게 최종 실패 처리와 회복 채널 종료를 일관되게 수행한다.
      if (heldWaitingSteps.length === 0) {
        await db.update(workflowRuns).set({ status: "failed", completedAt: now }).where(eq(workflowRuns.id, run.id));
        results.push({
          runId: run.id,
          action: "recovered",
          reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
        });
      } else {
        const heldIssueStatuses = [...new Set(heldWaitingSteps.map((step) =>
          step.issueId ? issueStatusById.get(step.issueId) ?? "missing" : "no-issue",
        ))].join("/");
        results.push({
          runId: run.id,
          action: "skipped",
          reason: `Held deadlock finalization: ${heldWaitingSteps.length} pending step(s) with non-terminal linked issue(s) (${heldIssueStatuses}); waiting for recovery`,
        });
      }
    } catch (error) {
      results.push({ runId: run.id, action: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function hasActiveWorkflowStep(db: Db, workflowRunId: string) {
  return db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
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
    ))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}

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
  if (!issue || issue.status === "blocked" || issue.status === "done" || issue.status === "cancelled") return;

  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, input.issueId), like(issueComments.body, `%${marker}%`)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return;

  const now = new Date();
  await db.update(issues).set({ status: "blocked", updatedAt: now }).where(eq(issues.id, input.issueId));
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
