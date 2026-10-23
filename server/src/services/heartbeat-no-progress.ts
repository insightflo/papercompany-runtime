import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { NO_PROGRESS_RUN_SCAN_LIMIT, resolveNoProgressWindowMs } from "./heartbeat-stability.js";
import { readC07ProgressEvidence } from "./heartbeat-progress-evidence.js";

export type NoProgressAssessment = {
  count: number;
  windowStart: Date;
  lastRunId: string | null;
  runsInspected: number;
  evidenceSummary: { runs: number; workProductRuns: number; toolProgressRuns: number };
};

/** Recompute the consecutive successful runs from the existing six-hour, twenty-run window.
 * Only accepted tool advances and measured product creation/change reset the chain.
 * No elapsed-time sum, process-local counter or current-generation partition is introduced.
 */
export async function computeConsecutiveNoProgress(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; agentId: string; now?: Date },
): Promise<NoProgressAssessment | null> {
  const windowMs = resolveNoProgressWindowMs();
  if (!(windowMs > 0)) return null;
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowMs);
  const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.issueId, input.issueId),
    eq(heartbeatRuns.agentId, input.agentId),
    eq(heartbeatRuns.status, "succeeded"),
    gte(heartbeatRuns.createdAt, windowStart),
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(NO_PROGRESS_RUN_SCAN_LIMIT);
  const evidence = await readC07ProgressEvidence(db, { ...input, runIds: runs.map(run => run.id) });
  let count = 0;
  let lastRunId: string | null = null;
  for (const run of runs) {
    if (evidence.byRun.has(run.id)) break;
    if (count === 0) lastRunId = run.id;
    count += 1;
  }
  const countRuns = (kind: "tool" | "work_product") =>
    [...evidence.byRun.values()].filter(items => items.some(item => item.kind === kind)).length;
  return {
    count, windowStart, lastRunId, runsInspected: runs.length,
    evidenceSummary: { runs: runs.length, workProductRuns: countRuns("work_product"), toolProgressRuns: countRuns("tool") },
  };
}
