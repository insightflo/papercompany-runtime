import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { attemptFullSettlement } from "./settlement.js";
import { syncWorkflowAfterHeartbeatSettlement } from "./post-execution.js";

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];

/**
 * Phase 3 recovery (plan section 5, M1/N3): replays settlement for v1 runs that
 * reached terminal status but were not settled (crash window between setRunStatus
 * and settlement). After a fixed grace, re-attempts the full settlement pipeline:
 * ensureFinalization -> observe quiescence -> record Q stages if proven -> settle.
 *
 * FLAG-GATED: with the flag OFF, this is a no-op. With the flag ON, a recovered
 * settlement makes the run lifecycle-inactive and its linked workflow step dispatch-ready.
 *
 * Returns the number of runs processed.
 */
export async function recoverTerminalUnsettledRuns(
  db: Db,
  now: Date = new Date(),
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<number> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return 0;

  const cutoff = new Date(now.getTime() - graceMs);
  const cutoffIso = cutoff.toISOString();
  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      finalizationVersion: heartbeatRuns.finalizationVersion,
      settledAt: heartbeatRuns.settledAt,
    })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.status, TERMINAL_STATUSES),
      eq(heartbeatRuns.finalizationVersion, 1),
      isNull(heartbeatRuns.settledAt),
      sql`COALESCE(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) < ${cutoffIso}`,
    ))
    .limit(50);

  let processed = 0;
  for (const candidate of candidates) {
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
      if (!run || run.finalizationVersion !== 1 || run.settledAt) continue;

      // Every terminal-unsettled v1 run replays the same full settlement pipeline
      // the normal execution path uses. settleRunIfReady alone never materializes
      // the compensable C stages (issue promotion / workflow evidence sync), so
      // runs that terminalized with any other error code (adapter_failed,
      // issue_status_blocked, cancelled, timed_out, ...) stayed pending forever,
      // kept their sources classified as stale, and fed the unblock-anchor loop.
      const settlement = await attemptFullSettlement(db, run, now);
      if (settlement === "settled") {
        await syncWorkflowAfterHeartbeatSettlement(db, run);
      }
      processed += 1;
    } catch {
      // Recovery is best-effort; individual failures are retried on the next tick.
    }
  }
  return processed;
}
