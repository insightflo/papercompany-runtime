import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { ensureFinalization } from "./finalization-state.js";
import { decideHeartbeatTerminalOutcomeFirstWins, releaseExecutorOwnerCapability } from "./owner-capability.js";
import type { HeartbeatRun } from "./owner-capability.js";


const TERMINAL_OUTCOME: Record<string, "succeeded" | "failed" | "cancelled" | "timed_out" | undefined> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out",
};

/**
 * Terminal routing choke point invoked from setRunStatus whenever a run transitions
 * to a terminal status:
 *
 * - feature-flagged (enableHeartbeatFinalizationV1); OFF => immediate no-op.
 * - only acts on finalizationVersion=1 runs (v1 claimed runs); legacy runs untouched.
 * - the entire body is wrapped so a finalization failure can NEVER alter the real terminal
 *   outcome, live event, transition event, promotion, or recovery behavior.
 * - records the finalization parent and first-wins terminal outcome, then releases
 *   owner authority. Settlement runs only after executeRun cleanup completes.
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

    // Re-read so finalization sees the latest committed row state.
    const [fresh] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, updatedRun.id));
    if (!fresh || fresh.finalizationVersion !== 1) return;

    await decideHeartbeatTerminalOutcomeFirstWins(db, { run: fresh, outcome, source: `heartbeat_terminal:${updatedRun.status}`, now });
    // Re-read so the finalization parent reflects the first-wins terminal outcome just written.
    const [decided] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, updatedRun.id));
    if (decided) {
      await ensureFinalization(db, decided, now);
      // Release the executor owner capability so the quiescence probe sees
      // executorOwnerReleasedAt != null and the run can settle.
      await releaseExecutorOwnerCapability(db, decided, now);
    }
  } catch {
    // Never propagate. The real terminal flow has already committed.
  }
}
