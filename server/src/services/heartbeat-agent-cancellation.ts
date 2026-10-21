import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type agentWakeupRequests, type Db } from "@paperclipai/db";
import type { runningProcesses } from "../adapters/index.js";
import { notFound } from "../errors.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export type HeartbeatAgentCancellationDeps = {
  readonly db: Db;
  readonly getRun: (runId: string) => Promise<HeartbeatRun | null>;
  readonly setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatuses?: string[] },
  ) => Promise<HeartbeatRun | null>;
  readonly setWakeupStatus: (
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) => Promise<void>;
  readonly appendRunEvent: (
    run: HeartbeatRun,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  readonly releaseIssueExecutionAndPromote: (
    run: HeartbeatRun,
    options?: { readonly skipLocked?: boolean; readonly resumeQueue?: boolean },
  ) => Promise<unknown>;
  readonly finalizeAgentStatus: (agentId: string, outcome: "cancelled") => Promise<void>;
  readonly startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
  readonly terminateRecordedProcess: (
    pid: number | null | undefined,
    signal?: NodeJS.Signals,
  ) => boolean;
  readonly runningProcesses: Pick<typeof runningProcesses, "get" | "delete">;
};

export function createHeartbeatAgentCancellation(deps: HeartbeatAgentCancellationDeps) {
  const {
    db, getRun, setRunStatus, setWakeupStatus, appendRunEvent,
    releaseIssueExecutionAndPromote, finalizeAgentStatus, startNextQueuedRunForAgent,
    terminateRecordedProcess, runningProcesses,
  } = deps;

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane", resumeQueue = true) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
      setTimeout(() => {
        terminateRecordedProcess(run.processPid, "SIGKILL");
      }, 5_000);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    }, { expectedStatuses: ["queued", "running"] });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled, { resumeQueue });
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    if (resumeQueue) await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      }, { expectedStatuses: ["queued", "running"] });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses.delete(run.id);
      } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
        setTimeout(() => {
          terminateRecordedProcess(run.processPid, "SIGKILL");
        }, 5_000);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  return { cancelRunInternal, cancelActiveForAgentInternal };
}
