import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";

type ReaderDb = Pick<Db, "select">;

/**
 * Phase 2 lifecycle-consumer migration (plan section 9), FLAG-GATED and shadow-safe.
 *
 * "Lifecycle active" = a run that still occupies agent capacity / counts as in-flight.
 *
 * IMPORTANT: Even when the flag is ON, lifecycle-active returns the legacy clause
 * (status = 'running'). Settlement tracking (settled_at) is shadow-only bookkeeping
 * and must NOT alter slot admission until the enforcement phase (Phase 3) is reached
 * and all settle paths are proven in production. Enforcing lifecycle changes before
 * settle is reliable causes permanent slot occupation (the run can never settle).
 */
export async function lifecycleActiveClause(db: ReaderDb): Promise<SQL> {
  return sql`heartbeat_runs.status = 'running'`;
}
/**
 * "In-flight" predicate: any run that should suppress a new timer wake / dedupe a
 * queued wakeup (queued OR running, OR — under the flag — terminal-but-unsettled v1).
 * Flag OFF => `status IN ('queued','running')` (legacy exact).
 */
export async function lifecycleInFlightClause(db: ReaderDb): Promise<SQL> {
  return sql`heartbeat_runs.status IN ('queued', 'running')`;
}
