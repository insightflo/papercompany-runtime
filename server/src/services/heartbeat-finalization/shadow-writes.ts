import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";
import { readAdmittedWorkflowIdentity } from "./producer-identity.js";
import { conflict } from "../../errors.js";
import {
  acknowledgeHeartbeatOwnerCapability,
  claimHeartbeatRunWithOwnerCapability,
  decideHeartbeatTerminalOutcomeFirstWins,
  type HeartbeatRun,
} from "./owner-capability.js";

export async function claimQueuedHeartbeatRun(db: Db, run: HeartbeatRun, claimedAt: Date): Promise<HeartbeatRun | null> {
  return db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
    if (!current || current.status !== "queued") return null;
    if (current.companyId !== run.companyId || current.agentId !== run.agentId || current.issueId !== run.issueId
      || current.wakeupRequestId !== run.wakeupRequestId || current.workflowStepRunId !== run.workflowStepRunId
      || current.workflowExecutionGeneration !== run.workflowExecutionGeneration) throw conflict("heartbeat_workflow_identity_changed");
    const identity = await readAdmittedWorkflowIdentity(tx as unknown as Db, current);
    if (await isHeartbeatFinalizationV1Enabled(tx as unknown as Db)) return claimHeartbeatRunWithOwnerCapability(tx as unknown as Db, current, claimedAt);
    return tx.update(heartbeatRuns).set({ status: "running", startedAt: run.startedAt ?? claimedAt, updatedAt: claimedAt,
      ...(identity ? { workflowStepRunId: identity.workflowStepRunId, workflowExecutionGeneration: identity.workflowExecutionGeneration } : {}) })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued")))
      .returning().then(rows => rows[0] ?? null);
  });
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
