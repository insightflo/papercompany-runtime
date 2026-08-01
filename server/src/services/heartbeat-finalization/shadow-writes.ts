import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import {
  acknowledgeHeartbeatOwnerCapability,
  claimHeartbeatRunWithOwnerCapability,
  decideHeartbeatTerminalOutcomeFirstWins,
  type HeartbeatRun,
} from "./owner-capability.js";

export async function claimQueuedHeartbeatRun(db: Db, run: HeartbeatRun, claimedAt: Date): Promise<HeartbeatRun | null> {
  if (await isHeartbeatFinalizationV1Enabled(db)) return claimHeartbeatRunWithOwnerCapability(db, run, claimedAt);
  return db.update(heartbeatRuns).set({ status: "running", startedAt: run.startedAt ?? claimedAt, updatedAt: claimedAt })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
    .returning().then((rows) => rows[0] ?? null);
}

export async function acknowledgeHeartbeatRunBeforeAdapter(db: Db, run: HeartbeatRun, now: Date): Promise<HeartbeatRun | null> {
  if (run.finalizationVersion !== 1 || !(await isHeartbeatFinalizationV1Enabled(db))) return run;
  return acknowledgeHeartbeatOwnerCapability(db, run, now);
}

export async function recordHeartbeatTerminalOutcomeShadow(db: Db, run: HeartbeatRun): Promise<void> {
  if (!isTerminalOutcome(run.status) || run.finalizationVersion !== 1 || !(await isHeartbeatFinalizationV1Enabled(db))) return;
  await decideHeartbeatTerminalOutcomeFirstWins(db, {
    run, outcome: run.status, source: `heartbeat_status:${run.status}:${run.errorCode ?? "terminal"}`, now: new Date(),
  });
}

function isTerminalOutcome(status: string): status is "succeeded" | "failed" | "cancelled" | "timed_out" {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}
