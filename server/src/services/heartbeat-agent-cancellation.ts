import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentApiKeys, agents, agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import type { runningProcesses } from "../adapters/index.js";
import { conflict, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { commitAgentResume } from "./heartbeat-agent-resume.js";
import { lockPauseFacts, recordPauseScope } from "./heartbeat-pause-intents.js";
import type { publishLiveEvent } from "./live-events.js";
import { commitPauseInvalidation, type PauseInvalidationTarget, type PauseInvalidationCause } from "./heartbeat-pause-invalidation.js";
import type { BudgetEnforcementScope } from "./budgets.js";

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

  // Only the existing claim-refusal callback uses this path; it does not invalidate resume intent.
  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane", resumeQueue = true) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    stopSingleRun(run);
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

  /** Public revocation is typed; the claim-refusal callback never grants user-cancel authority. */
  async function cancelControlled(target: PauseInvalidationTarget, cause: PauseInvalidationCause,
    reason: string, bulk: boolean) {
    const committed = await commitPauseInvalidation(db, target, cause, reason, setTransactionalRunStatus);
    // The root has committed every receipt/HB/wake before any process signal or queue progress.
    for (const { original, cancelled } of committed.changed) {
      publishRunStatus(cancelled);
      if (bulk) stopBulkRun(original); else stopSingleRun(original);
    }
    for (const { original, cancelled } of committed.changed) {
      if (!bulk) await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle", stream: "system", level: "warn", message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(bulk ? original : cancelled, { resumeQueue: bulk });
    }
    if (!bulk) {
      for (const agentId of new Set(committed.changed.map(({ original }) => original.agentId))) {
        await finalizeAgentStatus(agentId, "cancelled");
        await startNextQueuedRunForAgent(agentId);
      }
    }
    return committed;
  }

  async function cancelActiveForAgentInternal(agentId: string) {
    const result = await cancelControlled({ kind: "agent", id: agentId }, "user_cancel",
      "Cancelled due to agent pause", true);
    return result.changed.length;
  }

  function stopSingleRun(run: HeartbeatRun) {
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

    runningProcesses.delete(run.id);
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
    cancelRun: async (runId: string) => {
      const result = await cancelControlled({ kind: "run", id: runId }, "user_cancel", "Cancelled by control plane", false);
      return result.changed.find(({ original }) => original.id === runId)?.cancelled ?? result.requested ?? null;
    },
    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),
    resumeAgent: (agentId: string) => commitAgentResume(db, agentId),
    pauseAgent: (agentId: string) => controlAgent(agentId, "manual_pause"),
    terminateAgent: (agentId: string) => controlAgent(agentId, "terminate"),
  };
  const cancelBudgetScope = async (scope: BudgetEnforcementScope) => {
    await cancelControlled({ kind: "budget", scope }, "budget", "Cancelled due to budget pause", scope.scopeType === "agent");
  };
  return { cancelRunInternal, cancelBudgetScope, control };
}
