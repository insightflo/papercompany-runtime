import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { ReconciliationResult } from "./reconciler.js";
import { deferRunForQaCorrection } from "./control-flow/qa-correction-liveness.js";
import { isStepRunAwaitingRetry } from "./retry-reconciler.js";
import { hasLiveWorkflowChildWait } from "./workflow-child-execution.js";
import {
  evaluateRecoveryChannels, executeTerminalEffectIntents, finalizeRunTerminal,
  type FinalizeRunTerminalInput, type TerminalFinalizeResult,
} from "./run-terminal-boundary.js";
import {
  lockCascadeObservation, writeStuckCascade, writeDeadlockCascade,
  type CascadeTx, type FailureCascadeRun, type FailureCascadeStep, type DeadlockCascadeStep,
} from "./failure-cascade-writes.js";

type Finalized = Extract<TerminalFinalizeResult, { kind: "finalized" }>;
type Cancelled = Exclude<TerminalFinalizeResult, Finalized> | "stale_observation";

// Only the owner of the outer transaction translates this error into a result.
class CascadeCancelled extends Error {
  constructor(readonly result: Cancelled) {
    super("Failure cascade cancelled");
  }
}

// The observation enum is not a run row. Re-read the full row under the outer run/step locks.
async function deferCascadeForQaCorrection(tx: CascadeTx, run: FailureCascadeRun): Promise<void> {
  const [current] = await tx.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, run.companyId),
  ));
  if (!current) throw new CascadeCancelled("stale_observation");
  const deferred = await deferRunForQaCorrection(tx, current, "failed");
  if (deferred) throw new CascadeCancelled(deferred);
}

async function finalizeCascade(tx: CascadeTx, input: FinalizeRunTerminalInput): Promise<Finalized> {
  const boundary = await finalizeRunTerminal(tx, input);
  if (boundary.kind !== "finalized") throw new CascadeCancelled(boundary);
  return boundary;
}

function cancelledResult(runId: string, result: Cancelled, deadlock = false): ReconciliationResult {
  if (result === "stale_observation") {
    return { runId, action: "skipped", reason: "Failure cascade discarded: run or step observation changed" };
  }
  if (result.kind === "deferred") {
    return deadlock
      ? { runId, action: "skipped", reason: "Deadlock finalization deferred: recovery channel open/unknown; waiting for recovery" }
      : { runId, action: "deferred", reason: "Recovery channel opened during finalization; cascade rolled back, run left non-terminal" };
  }
  if (result.kind === "stale_authority") {
    return { runId, action: "skipped", reason: deadlock
      ? "Deadlock finalization discarded: run authority superseded"
      : "Run authority superseded; stuck finalization discarded" };
  }
  return { runId, action: "skipped", reason: deadlock
    ? "Deadlock finalization skipped: run already terminal" : "Run already terminal" };
}

async function terminalEffectNote(db: Db, decisionId: string): Promise<string> {
  try {
    await executeTerminalEffectIntents(db, decisionId);
    return "";
  } catch (error) {
    // Pending intents remain available to the periodic sweep after a committed decision.
    return ` (effect execution deferred to sweep: ${error instanceof Error ? error.message : String(error)})`;
  }
}

export async function settleStuckFailureCascade(
  db: Db,
  { run, pendingSteps, boundaryStepRuns, boundaryEnabled }: {
    run: FailureCascadeRun;
    pendingSteps: FailureCascadeStep[];
    boundaryStepRuns: FailureCascadeStep[];
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
  }

  try {
    const boundary = await db.transaction(async (tx) => {
      const observation = await lockCascadeObservation(tx, {
        kind: "stuck", run, pendingSteps, boundaryStepRuns, boundaryEnabled,
      });
      if (observation === "stale_observation") throw new CascadeCancelled(observation);
      if (observation === "current") await deferCascadeForQaCorrection(tx, run);
      if (observation === "current" && pendingSteps.length > 0) {
        await writeStuckCascade(tx, run, pendingSteps, new Date());
      }
      if (boundaryEnabled) {
        return await finalizeCascade(tx, {
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
      }
      await tx.update(workflowRuns).set({ status: "failed", completedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      return null;
    });
    const effectNote = boundary ? await terminalEffectNote(db, boundary.decisionId) : "";
    return {
      runId: run.id,
      action: "recovered",
      reason: boundary
        ? `Marked stuck run as failed (terminal decision ${boundary.decisionId})${effectNote}`
        : "Marked stuck run as failed",
    };
  } catch (error) {
    if (error instanceof CascadeCancelled) return cancelledResult(run.id, error.result);
    // Keep the caller's contention, timeout and ordinary failure classifications.
    throw error;
  }
}

export async function settleDeadlockFailureCascade(
  db: Db,
  { run, stepsToSkip, runSteps, boundaryEnabled, now, mayFinalize }: {
    run: FailureCascadeRun;
    stepsToSkip: FailureCascadeStep[];
    runSteps: DeadlockCascadeStep[];
    boundaryEnabled: boolean;
    now: Date;
    mayFinalize: boolean;
  },
): Promise<ReconciliationResult | null> {
  try {
    const boundary = await db.transaction(async (tx) => {
      const observation = await lockCascadeObservation(tx, {
        kind: "deadlock", run, stepsToSkip, runSteps, boundaryEnabled, mayFinalize,
      });
      if (observation === "stale_observation") throw new CascadeCancelled(observation);
      if (observation === "current") {
        await deferCascadeForQaCorrection(tx, run);
        await writeDeadlockCascade(tx, run, stepsToSkip, now);
      }
      // A valid mixed hold commits only its selected skips.
      if (!mayFinalize) return null;
      if (boundaryEnabled) {
        return await finalizeCascade(tx, {
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
      }
      await tx.update(workflowRuns).set({ status: "failed", completedAt: now })
        .where(eq(workflowRuns.id, run.id));
      return null;
    });
    if (!mayFinalize) return null;
    const effectNote = boundary ? await terminalEffectNote(db, boundary.decisionId) : "";
    return {
      runId: run.id,
      action: "recovered",
      reason: boundary
        ? `Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait (terminal decision ${boundary.decisionId})${effectNote}`
        : "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
    };
  } catch (error) {
    if (error instanceof CascadeCancelled) return cancelledResult(run.id, error.result, true);
    throw error;
  }
}
