import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";

type ReaderDb = Pick<Db, "select">;

/**
 * Phase 3 lifecycle-consumer migration (plan section 9), FLAG-GATED.
 *
 * "Lifecycle active" = a run that still occupies agent capacity / counts as in-flight.
 * Legacy (flag OFF): status = 'running' — byte-for-byte unchanged.
 * v1 (flag ON): status = 'running' OR (terminal status AND finalization_version = 1 AND
 * settled_at IS NULL). A terminal-but-unsettled v1 run is still lifecycle-active because
 * its mandatory post-processing (and thus its true completion) has not yet been observed.
 *
 * This is consumed by countRunningRunsForAgent (and therefore finalizeAgentStatus /
 * startNextQueuedRunForAgent slot admission). With the flag OFF, production behavior is
 * identical to legacy; the settlement-aware path only activates under the experimental flag.
 */
export async function lifecycleActiveClause(db: ReaderDb): Promise<SQL> {
  const v1 = await isHeartbeatFinalizationV1Enabled(db);
  if (!v1) {
    return sql`heartbeat_runs.status = 'running'`;
  }
  return sql`(
    heartbeat_runs.status = 'running'
    OR (
      heartbeat_runs.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
      AND heartbeat_runs.finalization_version = 1
      AND heartbeat_runs.settled_at IS NULL
    )
  )`;
}
/**
 * "In-flight" predicate: any run that should suppress a new timer wake / dedupe a
 * queued wakeup (queued OR running, OR — under the flag — terminal-but-unsettled v1).
 * Flag OFF => `status IN ('queued','running')` (legacy exact).
 */
export async function lifecycleInFlightClause(db: ReaderDb): Promise<SQL> {
  const v1 = await isHeartbeatFinalizationV1Enabled(db);
  if (!v1) {
    return sql`heartbeat_runs.status IN ('queued', 'running')`;
  }
  return sql`(
    heartbeat_runs.status IN ('queued', 'running')
    OR (
      heartbeat_runs.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
      AND heartbeat_runs.finalization_version = 1
      AND heartbeat_runs.settled_at IS NULL
    )
  )`;
}
