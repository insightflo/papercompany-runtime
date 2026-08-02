import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunFinalizations, heartbeatRuns, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { appendWorkflowAuthorityTransition } from "../workflow/authority/transitions.js";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import type { HeartbeatRun } from "./owner-capability.js";
import { allRequiredStages, Q_STAGE, STAGE_CLASS } from "./stage-classifier.js";
import { ensureFinalization, loadStages, recordStage, setStageState } from "./finalization-state.js";
import { observeQuiescenceProof } from "./quiescence-probe.js";


export type SettlementOutcome = "settled" | "not_ready" | "blocked_noncompensable";
type SettleDb = Pick<Db, "select" | "update" | "insert" | "transaction">;

/**
 * Settlement gate (plan sections 5 & Q1). Phase 3 readers consume settled_at and
 * dispatch_ready_at to admit the next workflow step. Invariants enforced here:
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
  // Blocker 2 fix: aggregate ALL rows per stageKind, fail-closed.
  // The unique index includes idempotency_key, so multiple rows for the same
  // stageKind (e.g. done + dead_letter from different idempotency keys) can coexist.
  // A Map (last-wins) would miss a dead_letter if a done row follows it.
  const stagesByKind = new Map<string, string[]>();
  for (const s of stages) {
    const arr = stagesByKind.get(s.stageKind);
    if (arr) arr.push(s.state);
    else stagesByKind.set(s.stageKind, [s.state]);
  }

  let blockedNonCompensable = false;
  for (const stage of required) {
    const states = stagesByKind.get(stage.kind) ?? [];
    if (stage.stageClass === STAGE_CLASS.quiescence) {
      if (states.includes("dead_letter")) {
        blockedNonCompensable = true; // non-compensable dead-end: never settles
        continue;
      }
      if (!states.includes("done")) return "not_ready"; // positive observation required
    } else if (stage.stageClass === STAGE_CLASS.compensable) {
      if (!states.includes("done") && !states.includes("equivalent_failed")) return "not_ready";
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
  // settled_at and dispatch_ready_at are one authority transition: if the linked
  // workflow step cannot receive dispatch readiness, the transaction rolls back
  // settled_at as well so the recovery lane can safely retry.
  const settled = await db.transaction(async (tx) => {
    const row = await tx
      .update(heartbeatRuns)
      .set({ settledAt: now, updatedAt: now })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.finalizationVersion, 1),
        isNull(heartbeatRuns.settledAt),
      ))
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows[0] ?? null);

    if (!row) return null;

    if (run.workflowStepRunId) {
      if (run.workflowExecutionGeneration === null) {
        throw new Error(`Cannot settle heartbeat ${run.id}: linked workflow execution generation is missing`);
      }
      const stepRun = await tx
        .select({ id: workflowStepRuns.id, dispatchReadyAt: workflowStepRuns.dispatchReadyAt })
        .from(workflowStepRuns)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
        .where(and(
          eq(workflowStepRuns.id, run.workflowStepRunId),
          eq(workflowStepRuns.executionGeneration, run.workflowExecutionGeneration),
          eq(workflowRuns.companyId, run.companyId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!stepRun) {
        throw new Error(`Cannot settle heartbeat ${run.id}: linked workflow step run ${run.workflowStepRunId} was not found`);
      }

      if (!stepRun.dispatchReadyAt) {
        const ready = await tx
          .update(workflowStepRuns)
          .set({ dispatchReadyAt: now })
          .where(and(
            eq(workflowStepRuns.id, run.workflowStepRunId),
            eq(workflowStepRuns.executionGeneration, run.workflowExecutionGeneration),
            isNull(workflowStepRuns.dispatchReadyAt),
          ))
          .returning({ id: workflowStepRuns.id })
          .then((rows) => rows[0] ?? null);
        if (!ready) {
          throw new Error(`Cannot settle heartbeat ${run.id}: dispatch readiness CAS failed for ${run.workflowStepRunId}`);
        }
      }
    }

    await appendWorkflowAuthorityTransition(tx, {
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
    });
    return row;
  });
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


/**
 * Full settlement pipeline for a terminal v1 run: observe quiescence → record Q
 * stages if proven → record C stages whose executeRun path has completed → settle.
 * Call this only after executeRun has finished its business side-effects and runtime
 * cleanup. The earlier terminal-status hook records outcome/owner release only.
 */
export async function attemptFullSettlement(
  db: SettleDb,
  run: HeartbeatRun,
  now: Date,
): Promise<SettlementOutcome> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return "not_ready";
  if (run.finalizationVersion !== 1) return "not_ready";

  const fin = await ensureFinalization(db, run, now);

  // Observe quiescence and record Q stages if positively proven.
  const proof = await observeQuiescenceProof(db, run);
  if (proof) {
    for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped, Q_STAGE.missionRuntimeIdle]) {
      await recordStage(db, {
        companyId: run.companyId,
        runId: run.id,
        finalizationId: fin.id,
        stageClass: STAGE_CLASS.quiescence,
        stageKind: kind,
        idempotencyKey: `settle-q:${kind}:${run.id}`,
        state: "done",
        payload: { source: "attempt_full_settlement", proof },
      }).catch(() => undefined);
    }
  }

  // The caller runs after executeRun's business side-effects and runtime cleanup,
  // so applicable compensable stages have completed on this normal execution path.
  const stages = allRequiredStages(run);
  for (const stage of stages) {
    if (stage.stageClass === STAGE_CLASS.compensable) {
      await recordStage(db, {
        companyId: run.companyId,
        runId: run.id,
        finalizationId: fin.id,
        stageClass: STAGE_CLASS.compensable,
        stageKind: stage.kind,
        idempotencyKey: `settle-c:${stage.kind}:${run.id}`,
        state: "done",
      }).catch(() => undefined);
    }
  }

  return settleRunIfReady(db, run, now);
}
