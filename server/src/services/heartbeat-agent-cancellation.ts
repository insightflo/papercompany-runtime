import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentApiKeys, agents, agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import type { runningProcesses } from "../adapters/index.js";
import { conflict, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { lockPauseFacts, recordPauseScope } from "./heartbeat-pause-intents.js";
import type { publishLiveEvent } from "./live-events.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export function publishHeartbeatRunStatus(publish: typeof publishLiveEvent, updated: HeartbeatRun) {
  publish({
    companyId: updated.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: updated.id,
      agentId: updated.agentId,
      status: updated.status,
      invocationSource: updated.invocationSource,
      triggerDetail: updated.triggerDetail,
      error: updated.error ?? null,
      errorCode: updated.errorCode ?? null,
      startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
      finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
    },
  });
}

export type HeartbeatAgentCancellationDeps = {
  readonly db: Db;
  readonly getRun: (runId: string) => Promise<HeartbeatRun | null>;
  readonly setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatuses?: string[] },
  ) => Promise<HeartbeatRun | null>;
  readonly setTransactionalRunStatus: (
    connection: Db,
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatuses?: string[]; deferLiveEvent?: boolean },
  ) => Promise<HeartbeatRun | null>;
  readonly publishRunStatus: (run: HeartbeatRun) => void;
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
    db, getRun, setRunStatus, setTransactionalRunStatus, publishRunStatus, setWakeupStatus, appendRunEvent,
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

      stopBulkRun(run);
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  function stopBulkRun(run: HeartbeatRun) {
    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      runningProcesses.delete(run.id);
    } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
      setTimeout(() => {
        terminateRecordedProcess(run.processPid, "SIGKILL");
      }, 5_000);
    }
  }

  const activeRuns = (connection: Db, agentId: string) => connection.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
    .orderBy(heartbeatRuns.id);

  /** C05: the transaction owns status, scope, originals and key revocation.
   * Only its returned targets authorize signals; cancelled is not proof of process exit.
   */
  async function controlAgent(agentId: string, cause: "manual_pause" | "terminate") {
    const reason = "Cancelled due to agent pause";
    const changed = () => { throw conflict("heartbeat_pause_scope_unproven_or_changed"); };
    const committed = await db.transaction(async tx => {
      const t = tx as unknown as Db;
      const [observed] = await t.select().from(agents).where(eq(agents.id, agentId));
      if (!observed) return null;
      const candidates = await activeRuns(t, agentId);
      const facts = await lockPauseFacts(t, { companyId: observed.companyId, agentId, cause,
        heartbeatRunIds: candidates.map(run => run.id) });
      // lockPauseFacts also locks prior undelivered originals. Never acquire new targets here.
      const runs = await activeRuns(t, agentId);
      if (runs.length !== candidates.length || runs.some((run, index) => run.id !== candidates[index].id)) changed();
      const svc = agentService(t);
      const agent = cause === "manual_pause" ? await svc.pause(agentId) : await svc.terminate(agentId);
      if (!agent || agent.status !== (cause === "manual_pause" ? "paused" : "terminated")) return changed();
      if (cause === "terminate") {
        const liveKeys = await t.select({ id: agentApiKeys.id }).from(agentApiKeys)
          .where(and(eq(agentApiKeys.agentId, agentId), isNull(agentApiKeys.revokedAt))).limit(1);
        if (liveKeys.length) return changed();
      }
      await recordPauseScope(t, facts);
      const targets: { original: HeartbeatRun; cancelled: HeartbeatRun }[] = [];
      for (const run of runs) {
        const cancelled = await setTransactionalRunStatus(t, run.id, "cancelled", {
          finishedAt: new Date(), error: reason, errorCode: "cancelled",
        }, { expectedStatuses: [run.status], deferLiveEvent: true });
        if (!cancelled || cancelled.status !== "cancelled") return changed();
        if (run.wakeupRequestId) {
          const [wake] = await t.update(agentWakeupRequests).set({
            status: "cancelled", finishedAt: new Date(), error: reason, updatedAt: new Date(),
          }).where(and(eq(agentWakeupRequests.id, run.wakeupRequestId),
            eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.runId, run.id))).returning();
          if (!wake || wake.status !== "cancelled") return changed();
        }
        targets.push({ original: run, cancelled });
      }
      // Legacy optional terminal hooks catch errors. A failed SQL statement must still abort this save.
      await t.execute(sql`select 1`);
      return { agent, targets };
    });
    if (!committed) return null;
    for (const { original, cancelled } of committed.targets) {
      publishRunStatus(cancelled);
      stopBulkRun(original);
      await releaseIssueExecutionAndPromote(original);
    }
    return committed.agent;
  }

  const control = {
    cancelRun: (runId: string) => cancelRunInternal(runId),
    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),
    pauseAgent: (agentId: string) => controlAgent(agentId, "manual_pause"),
    terminateAgent: (agentId: string) => controlAgent(agentId, "terminate"),
  };
  return { cancelRunInternal, cancelActiveForAgentInternal, control };
}
