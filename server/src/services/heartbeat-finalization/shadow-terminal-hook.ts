import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { ensureFinalization } from "./finalization-state.js";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { decideHeartbeatTerminalOutcomeFirstWins, releaseExecutorOwnerCapability } from "./owner-capability.js";
import { settleRunIfReady } from "./settlement.js";
import { observeQuiescenceProof } from "./quiescence-probe.js";
import { STAGE_CLASS, Q_STAGE } from "./stage-classifier.js";
import { recordStage } from "./finalization-state.js";
import type { HeartbeatRun } from "./owner-capability.js";


const TERMINAL_OUTCOME: Record<string, "succeeded" | "failed" | "cancelled" | "timed_out" | undefined> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out",
};

/**
 * Phase 2 shadow routing (plan section 9). A SINGLE defensive choke point invoked
 * from setRunStatus whenever a run transitions to a terminal status. SHADOW-ONLY:
 *
 * - feature-flagged (enableHeartbeatFinalizationV1); OFF => immediate no-op.
 * - only acts on finalizationVersion=1 runs (v1 claimed runs); legacy runs untouched.
 * - the entire body is wrapped so a shadow failure can NEVER alter the real terminal
 *   outcome, live event, transition event, promotion, or recovery behavior.
 * - records the finalization parent, first-wins terminal outcome, and attempts
 *   settlement. No reader consumes settled_at yet (Phase 3 enforces).
 *
 * This covers success/inner-catch/outer-catch/cancel/timeout/process_lost/
 * stale_queued/issue-done-child-kill uniformly via the terminal-writer choke point.
 */
export async function maybeRecordTerminalFinalization(
  db: Db,
  updatedRun: HeartbeatRun,
  now: Date,
): Promise<void> {
  try {
    if (!(await isHeartbeatFinalizationV1Enabled(db))) return;
    if (updatedRun.finalizationVersion !== 1) return;
    const outcome = TERMINAL_OUTCOME[updatedRun.status];
    if (!outcome) return;

    // Re-read so the probe/settlement see the latest committed row state.
    const [fresh] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, updatedRun.id));
    if (!fresh || fresh.finalizationVersion !== 1) return;

    await decideHeartbeatTerminalOutcomeFirstWins(db, { run: fresh, outcome, source: `heartbeat_terminal:${updatedRun.status}`, now });
    // Re-read so the finalization parent reflects the first-wins terminal outcome just written.
    const [decided] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, updatedRun.id));
    if (decided) {
      await ensureFinalization(db, decided, now);
      // Blocker 1 fix: release the executor owner capability so the quiescence probe
      // sees executorOwnerReleasedAt != null and the run can settle on normal termination.
      await releaseExecutorOwnerCapability(db, decided, now);
    }
    // Re-read after release so settlement sees executorOwnerReleasedAt set.
    const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, updatedRun.id));
    // Observe quiescence and record Q stages if proven, so settlement can complete
    // immediately on normal termination instead of waiting for the recovery lane.
    if (released && released.finalizationVersion === 1) {
      const fin = await ensureFinalization(db, released, now);
      const proof = await observeQuiescenceProof(db, released);
      if (proof) {
        for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped, Q_STAGE.missionRuntimeIdle]) {
          await recordStage(db, {
            companyId: released.companyId,
            runId: released.id,
            finalizationId: fin.id,
            stageClass: STAGE_CLASS.quiescence,
            stageKind: kind,
            idempotencyKey: `terminal-hook-q:${kind}:${released.id}`,
            state: "done",
            payload: { source: "terminal_hook", proof },
          }).catch(() => undefined);
        }
      }
    }
    // Settlement here is best-effort shadow bookkeeping; the recovery lane
    // (terminal-but-unsettled replay) re-attempts for runs that settle later.
    await settleRunIfReady(db, released ?? fresh, now);
  } catch {
    // Shadow-only: never propagate. The real terminal flow has already committed.
  }
}
