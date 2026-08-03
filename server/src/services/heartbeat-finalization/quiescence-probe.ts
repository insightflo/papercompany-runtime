import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, missionAgentRuntimes, workspaceOperations, workspaceRuntimeServices } from "@paperclipai/db";
import type { HeartbeatRun } from "./owner-capability.js";
import { Q_STAGE } from "./stage-classifier.js";

type ProbeDb = Pick<Db, "select">;

/** Returns true if the OS process recorded for the run is no longer alive (or was never tracked). */
function isExecutorProcessAbsent(run: HeartbeatRun): boolean {
  if (run.executorOwnerReleasedAt === null) return false; // owner capability not yet released
  if (run.processPid === null) return true; // no tracked process
  try {
    process.kill(run.processPid, 0);
    return false; // still alive
  } catch {
    return true; // ESRCH/EINVAL -> not alive
  }
}

async function noRunningWorkspaceOperations(db: ProbeDb, run: HeartbeatRun): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.heartbeatRunId, run.id),
      eq(workspaceOperations.status, "running"),
    ));
  return Number(n ?? 0) === 0;
}

async function runOwnedRuntimeServicesStopped(db: ProbeDb, run: HeartbeatRun): Promise<boolean> {
  const rows = await db
    .select({ status: workspaceRuntimeServices.status, stoppedAt: workspaceRuntimeServices.stoppedAt })
    .from(workspaceRuntimeServices)
    .where(eq(workspaceRuntimeServices.startedByRunId, run.id));
  if (rows.length === 0) return true;
  return rows.every((r) => r.status === "stopped" || r.stoppedAt !== null);
}

async function missionRuntimeNotBusy(db: ProbeDb, run: HeartbeatRun): Promise<boolean> {
  if (run.executionScopeKind !== "workflow_step" && run.executionScopeKind !== "mission_nonworkflow") {
    return true; // not mission-scoped
  }
  const [{ n }] = await db
    .select({ n: count() })
    .from(missionAgentRuntimes)
    .where(and(
      eq(missionAgentRuntimes.lastRunId, run.id),
      inArray(missionAgentRuntimes.status, ["starting", "ready", "busy", "stopping"]),
      isNull(missionAgentRuntimes.stoppedAt),
    ));
  return Number(n ?? 0) === 0;
}

export interface QuiescenceProof {
  observedAt: string;
  checks: Record<string, boolean>;
}

/**
 * Class-Q positive observation. Returns a proof only when EVERY non-compensable
 * precondition is positively observed (never on timeout/absence-of-evidence).
 * A null return means quiescence is NOT proven and settlement must stay blocked.
 */
export async function observeQuiescenceProof(
  db: ProbeDb,
  run: HeartbeatRun,
): Promise<QuiescenceProof | null> {
  const checks: Record<string, boolean> = {
    [Q_STAGE.executorQuiescence]: isExecutorProcessAbsent(run),
    [Q_STAGE.workspaceOperationsSettled]: await noRunningWorkspaceOperations(db, run),
    [Q_STAGE.runtimeServicesStopped]: await runOwnedRuntimeServicesStopped(db, run),
    [Q_STAGE.missionRuntimeIdle]: await missionRuntimeNotBusy(db, run),
  };
  const allObserved = Object.values(checks).every(Boolean);
  if (!allObserved) return null;
  return { observedAt: new Date().toISOString(), checks };
}

/** Re-reads the run so probe inputs reflect current DB state. */
export async function reloadRun(db: ProbeDb, runId: string): Promise<HeartbeatRun | null> {
  const [row] = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  return (row as HeartbeatRun | undefined) ?? null;
}
