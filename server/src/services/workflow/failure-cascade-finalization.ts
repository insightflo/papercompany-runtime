import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, like, sql } from "drizzle-orm";
import type { ReconciliationResult } from "./reconciler.js";
import { isStepRunAwaitingRetry } from "./retry-reconciler.js";
import { hasLiveWorkflowChildWait } from "./workflow-child-execution.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import { evaluateRecoveryChannels, executeTerminalEffectIntents, finalizeRunTerminal, type TerminalStepRunRef } from "./run-terminal-boundary.js";

type FailureCascadeRun = Pick<typeof workflowRuns.$inferSelect, "id" | "companyId" | "missionId" | "dispatchAuthorityVersion">;
type FailureCascadeStep = TerminalStepRunRef & { statusTransitionVersion: number };

const DEADLOCK_COMMENT_MARKER = "control-plane-deadlock";

export async function settleStuckFailureCascade(
  db: Db,
  { run, pendingSteps, boundaryStepRuns, boundaryEnabled }: {
    run: FailureCascadeRun;
    pendingSteps: FailureCascadeStep[];
    boundaryStepRuns: TerminalStepRunRef[];
    boundaryEnabled: boolean;
  },
): Promise<ReconciliationResult> {
  if (pendingSteps.length > 0) {
    const normalizeMetadata = (m: unknown): Record<string, unknown> =>
      m && typeof m === "object" && !Array.isArray(m)
        ? (m as Record<string, unknown>)
        : {};
    // [finding 2] 살아있는 자동 재시도(waiting/dispatching)가 있는 run 은 통째로 진행 중 —
    // 어떤 스텝도 skip 하지 않고 run failed 도 금지. Operator 보고는 억제된다.
    // [workflow child step] pending 스텝 중 하나라도 자식 run 대기가 있으면 동일(fix round P1-7).
    if (pendingSteps.some((step) => isStepRunAwaitingRetry(normalizeMetadata(step.metadata)))) {
      return { runId: run.id, action: "skipped", reason: "Workflow run has a live workflow retry in progress" };
    }
    const liveChildWaits = await Promise.all(
      pendingSteps.map((step) => hasLiveWorkflowChildWait(db, step)),
    );
    if (liveChildWaits.some(Boolean)) {
      return { runId: run.id, action: "skipped", reason: "Workflow run has live workflow child step waits in progress" };
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
        return {
          runId: run.id,
          action: "deferred",
          reason: `Recovery channel open/unknown; finalization deferred (${evidenceSummary})`,
        };
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
      return { runId: run.id, action: "deferred", reason: "Recovery channel opened during finalization; steps skipped, run left non-terminal" };
    }
    if (boundary.kind === "stale_authority") {
      return { runId: run.id, action: "skipped", reason: "Run authority superseded; stuck finalization discarded" };
    }
    if (boundary.kind === "already_finalized") {
      return { runId: run.id, action: "skipped", reason: "Run already terminal" };
    }
    let effectNote = "";
    try {
      await executeTerminalEffectIntents(db, boundary.decisionId);
    } catch (error) {
      // 부작용 실행 실패는 관측 사항 — pending 인텐트는 periodic sweep 이 재처리한다(계약).
      effectNote = ` (effect execution deferred to sweep: ${error instanceof Error ? error.message : String(error)})`;
    }
    return {
      runId: run.id,
      action: "recovered",
      reason: `Marked stuck run as failed (terminal decision ${boundary.decisionId})${effectNote}`,
    };
  }

  // Mark the run as failed
  await db
    .update(workflowRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
    })
    .where(eq(workflowRuns.id, run.id));

  return {
    runId: run.id,
    action: "recovered",
    reason: "Marked stuck run as failed",
  };
}

export async function settleDeadlockFailureCascade(
  db: Db,
  { run, stepsToSkip, runSteps, boundaryEnabled, now, mayFinalize }: {
    run: FailureCascadeRun;
    stepsToSkip: FailureCascadeStep[];
    runSteps: TerminalStepRunRef[];
    boundaryEnabled: boolean;
    now: Date;
    mayFinalize: boolean;
  },
): Promise<ReconciliationResult | null> {
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
  if (!mayFinalize) return null;
  if (boundaryEnabled) {
    // [run-terminal-boundary v1] 최종 수렴을 경계로 우회한다 — CAS/원인 스탬프/회복 게이트는
    //   코어 계약(run-terminal-boundary.ts)이 소유한다. 채널이 열리면 유예되어 run 은 비종말로 남는다.
    const boundary = await finalizeRunTerminal(db, {
      runId: run.id,
      companyId: run.companyId,
      expectedAuthorityVersion: run.dispatchAuthorityVersion,
      decision: "failed",
      cause: {
        policy: "recovery_deadline_hard",
        discovery: "deadlock_detection",
        origin: "deadlock_reconciler",
        reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
      },
      gatePolicy: "defer_on_open_recovery",
      now,
      stepRuns: runSteps,
    });
    if (boundary.kind === "finalized") {
      let effectNote = "";
      try {
        await executeTerminalEffectIntents(db, boundary.decisionId);
      } catch (error) {
        // 부작용 실행 실패는 관측 사항 — pending 인텐트는 periodic sweep 이 재처리한다(계약).
        effectNote = ` (effect execution deferred to sweep: ${error instanceof Error ? error.message : String(error)})`;
      }
      return {
        runId: run.id,
        action: "recovered",
        reason: `Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait (terminal decision ${boundary.decisionId})${effectNote}`,
      };
    } else if (boundary.kind === "deferred") {
      return { runId: run.id, action: "skipped", reason: "Deadlock finalization deferred: recovery channel open/unknown; waiting for recovery" };
    } else if (boundary.kind === "stale_authority") {
      return { runId: run.id, action: "skipped", reason: "Deadlock finalization discarded: run authority superseded" };
    } else {
      return { runId: run.id, action: "skipped", reason: "Deadlock finalization skipped: run already terminal" };
    }
  } else {
    await db.update(workflowRuns).set({ status: "failed", completedAt: now }).where(eq(workflowRuns.id, run.id));
    return {
      runId: run.id,
      action: "recovered",
      reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
    };
  }
}

async function blockIssueOnDeadlock(
  db: Db,
  input: { issueId: string; companyId: string; runId: string; stepId: string },
) {
  const marker = `[${DEADLOCK_COMMENT_MARKER}:${input.runId}:${input.stepId}]`;
  const issue = await db
    .select({ status: issues.status, language: sql<string>`(select default_language from companies where id = ${issues.companyId})` })
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
    body: `unreachable: upstream step failed; replan or cancel ${marker}\n${issue.language === "ko" ? "선행 단계 실패로 이 단계를 실행할 수 없습니다. 다음 행동: 실패한 의존 업무를 확인한 뒤 수정 계획을 제출하거나 업무를 취소해 주세요. 이 차단은 재시도를 요청하지 않습니다." : "The upstream failure prevents this step from running. Next action: review the failed dependency, then submit a revised plan or cancel the work. This block does not request a retry."}`,
    createdAt: now,
    updatedAt: now,
  });
}
