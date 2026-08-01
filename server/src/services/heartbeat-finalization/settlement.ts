import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunFinalizations, heartbeatRuns } from "@paperclipai/db";
import { appendWorkflowAuthorityTransition } from "../workflow/authority/transitions.js";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import type { HeartbeatRun } from "./owner-capability.js";
import { allRequiredStages, STAGE_CLASS } from "./stage-classifier.js";
import { loadStages, setStageState } from "./finalization-state.js";


export type SettlementOutcome = "settled" | "not_ready" | "blocked_noncompensable";
type SettleDb = Pick<Db, "select" | "update" | "insert">;

/**
 * Settlement gate (plan sections 5 & Q1). SHADOW-ONLY: writes heartbeat_runs.settled_at
 * but no reader consumes it yet (Phase 2/3 wire+enforce). Invariants enforced here:
 *
 * 1. Class-Q (non-compensable) stages require a positively-observed `done` step.
 *    A Q stage that is `dead_letter` permanently blocks settlement: the finalization
 *    is marked `blocked_noncompensable` and can NEVER settle via compensation,
 *    timeout, or dead-letter. This is absolute.
 * 2. Class-C (compensable) stages are satisfied by `done` OR `equivalent_failed`
 *    (a defined equivalent structured failure). Compensation can never satisfy a Q stage.
 * 3. Class-O (optional) stages never block; `dead_letter` is acceptable.
 * 4. settled_at is first-wins (CAS WHERE settled_at IS NULL) and idempotent on repeat.
 *
 * Missing/unstarted mandatory stages => not_ready (no settlement), never a forced settle.
 */
export async function settleRunIfReady(
  db: SettleDb,
  run: HeartbeatRun,
  now: Date,
): Promise<SettlementOutcome> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return "not_ready";
  if (run.finalizationVersion !== 1) return "not_ready";

  const required = allRequiredStages(run);
  const stages = await loadStages(db, run.id);
  const byKind = new Map(stages.map((s) => [s.stageKind, s.state]));

  let blockedNonCompensable = false;
  for (const stage of required) {
    const state = byKind.get(stage.kind);
    if (stage.stageClass === STAGE_CLASS.quiescence) {
      if (state === "dead_letter") {
        blockedNonCompensable = true; // non-compensable dead-end: never settles
        continue;
      }
      if (state !== "done") return "not_ready"; // positive observation required
    } else if (stage.stageClass === STAGE_CLASS.compensable) {
      if (state !== "done" && state !== "equivalent_failed") return "not_ready";
    }
    // optional (O): never blocks
  }

  const finalization = await db
    .select()
    .from(heartbeatRunFinalizations)
    .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id))
    .then((rows) => rows[0] ?? null);

  if (blockedNonCompensable) {
    if (finalization && finalization.state !== "blocked_noncompensable") {
      await db
        .update(heartbeatRunFinalizations)
        .set({ state: "blocked_noncompensable", updatedAt: now })
        .where(eq(heartbeatRunFinalizations.id, finalization.id));
    }
    return "blocked_noncompensable";
  }

  // All Q positively observed and all C done/equivalent-failed: settle (first-wins CAS).
  const settled = await db
    .update(heartbeatRuns)
    .set({ settledAt: now, updatedAt: now })
    .where(and(
      eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.finalizationVersion, 1),
      isNull(heartbeatRuns.settledAt),
    ))
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows[0] ?? null);

  if (settled) {
    await appendWorkflowAuthorityTransition(db, {
      companyId: run.companyId,
      workflowStepRunId: run.workflowStepRunId,
      issueId: run.issueId,
      wakeupRequestId: run.wakeupRequestId,
      heartbeatRunId: run.id,
      executionGeneration: run.workflowExecutionGeneration,
      executorOwnerId: run.executorOwnerId,
      reason: "heartbeat_settled",
      idempotencyKey: `heartbeat-settled:${run.id}`,
      payload: {
        version: 1,
        transition: "heartbeat_settled",
        executionEpoch: run.executionEpoch,
        terminalOutcome: run.terminalOutcome,
      },
    }).catch(() => undefined);
  }
  return settled ? "settled" : "not_ready";
}

/**
 * Marks a Q stage dead-lettered (e.g. an unrecoverable non-compensable failure observed
 * by the recovery lane). Once any Q stage is dead-lettered, settlement is permanently
 * blocked_noncompensable — this is the fail-closed path for unobservable quiescence.
 */
export async function markQuiescenceStageDeadLetter(
  db: SettleDb,
  stepId: string,
  now: Date,
): Promise<void> {
  await setStageState(db, stepId, "dead_letter", now);
}
