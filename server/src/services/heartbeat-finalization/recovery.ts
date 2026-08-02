import { and, eq, isNull, lt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, heartbeatRunFinalizations } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { ensureFinalization, recordStage } from "./finalization-state.js";
import { observeQuiescenceProof } from "./quiescence-probe.js";
import { settleRunIfReady } from "./settlement.js";
import { syncWorkflowAfterHeartbeatSettlement } from "./post-execution.js";
import { STAGE_CLASS, Q_STAGE } from "./stage-classifier.js";

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
      lt(sql`COALESCE(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`, cutoff),
    ))
    .limit(50);

  let processed = 0;
  for (const candidate of candidates) {
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
      if (!run || run.finalizationVersion !== 1 || run.settledAt) continue;

      const fin = await ensureFinalization(db, run, now);

      // Observe quiescence and record Q stages if proven.
      const proof = await observeQuiescenceProof(db, run);
      if (proof) {
        for (const kind of [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped, Q_STAGE.missionRuntimeIdle]) {
          await recordStage(db, {
            companyId: run.companyId,
            runId: run.id,
            finalizationId: fin.id,
            stageClass: STAGE_CLASS.quiescence,
            stageKind: kind,
            idempotencyKey: `recovery-q:${kind}:${run.id}`,
            state: "done",
            payload: { source: "terminal_unsettled_replay", proof },
          }).catch(() => undefined);
        }
      }

      const settlement = await settleRunIfReady(db, run, now);
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
