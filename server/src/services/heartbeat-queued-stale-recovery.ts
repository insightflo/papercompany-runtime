import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, heartbeatRuns, withTxTimeout } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { lifecycleActiveClause } from "./heartbeat-finalization/lifecycle-active.js";
import { operatorApprovalWaitService } from "./operator-approval-wait.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
type QueueEvent = {
  companyId: string;
  issueId?: string | null;
  wakeupRequestId?: string | null;
  eventType: string;
  layer: string;
  decision?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
};

export type HeartbeatQueuedStaleRecoveryDeps = {
  db: Db;
  activeExecutionTimeoutMs: number;
  withAgentStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  startNextQueuedRunForAgent(agentId: string): Promise<unknown>;
  countActiveRunsForAgent(agentId: string): Promise<number>;
  maxConcurrentRuns(agent: Agent): number;
  hasActiveExecution(runId: string): boolean;
  hasLiveTrackedChild(runId: string): boolean;
  resolveActiveExecutionTimeoutMs(run: Run, baseMs: number): Promise<number>;
  setRunStatus(db: Db, runId: string, status: string, patch: Partial<typeof heartbeatRuns.$inferInsert>, opts: { expectedStatuses: string[]; deferLiveEvent?: boolean }): Promise<Run | null>;
  publishRunStatus(run: Run): void;
  nextRunEventSeq(runId: string): Promise<number>;
  appendRunEvent(run: Run, seq: number, event: { eventType: string; stream?: "system" | "stdout" | "stderr"; level?: "info" | "warn" | "error"; message?: string; payload?: Record<string, unknown> }): Promise<void>;
  releaseIssueExecutionAndPromote(run: Run, options: { skipLocked: boolean }): Promise<unknown>;
  getRun(runId: string): Promise<Run | null>;
  settleHeartbeatAfterExecution(db: Db, run: Run, now: Date): Promise<unknown>;
  finalizeAgentStatus(agentId: string, outcome: "failed"): Promise<unknown>;
  recordQueueTransitionEvent(input: QueueEvent): Promise<unknown>;
};

function sameTime(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function olderThan(createdAt: Date | null, updatedAt: Date | null, thresholdMs: number) {
  const reference = createdAt ?? updatedAt;
  return Boolean(reference && Date.now() - reference.getTime() >= thresholdMs);
}

function isPreStart(run: Run) {
  return run.startedAt === null && run.processPid === null && run.processStartedAt === null && run.externalRunId === null;
}

export function createHeartbeatQueuedStaleRecovery(deps: HeartbeatQueuedStaleRecoveryDeps) {
  async function liveOccupiedSlots(conn: Db, companyId: string, agentId: string) {
    const activeClause = await lifecycleActiveClause(conn);
    const runs = await conn.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId),
      activeClause,
    ));
    const liveIds = new Set<string>();
    for (const run of runs) {
      if (deps.hasLiveTrackedChild(run.id)) {
        liveIds.add(run.id);
        continue;
      }
      if (!deps.hasActiveExecution(run.id)) continue;
      const timeoutMs = await deps.resolveActiveExecutionTimeoutMs(run, deps.activeExecutionTimeoutMs);
      const observedAt = new Date();
      if (timeoutMs > 0 && observedAt.getTime() - run.updatedAt.getTime() <= timeoutMs) liveIds.add(run.id);
    }
    return liveIds.size;
  }

  async function hasCurrentExecution(run: Run) {
    if (deps.hasLiveTrackedChild(run.id)) return true;
    if (!deps.hasActiveExecution(run.id)) return false;
    const timeoutMs = await deps.resolveActiveExecutionTimeoutMs(run, deps.activeExecutionTimeoutMs);
    return timeoutMs > 0 && Date.now() - run.updatedAt.getTime() <= timeoutMs;
  }

  async function capacityIsPositivelyFull(conn: Db, companyId: string, agent: Agent) {
    const occupied = await liveOccupiedSlots(conn, companyId, agent.id);
    return occupied >= deps.maxConcurrentRuns(agent);
  }

  async function promoteOrphanCandidates(
    candidates: Array<typeof agentWakeupRequests.$inferSelect>,
    alreadyAttempted: Set<string>,
    alreadyFailed: Set<string>,
  ) {
    const attempted = new Set(alreadyAttempted);
    const failed = new Set(alreadyFailed);
    for (const request of candidates) {
      if (attempted.has(request.agentId)) continue;
      const [agent] = await deps.db.select().from(agents).where(and(
        eq(agents.id, request.agentId), eq(agents.companyId, request.companyId),
      )).limit(1);
      if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) continue;
      const slots = deps.maxConcurrentRuns(agent) - await deps.countActiveRunsForAgent(agent.id);
      if (slots <= 0) continue;
      try {
        if (request.issueId && (await operatorApprovalWaitService(deps.db).markerForIssue(request.issueId)).waiting) continue;
        // The ordinary promoter owns this lock itself; never call it from inside the lock below.
        attempted.add(agent.id);
        await deps.startNextQueuedRunForAgent(agent.id);
      } catch (error) {
        failed.add(agent.id);
        logger.warn({ error, agentId: agent.id }, "ordinary wake promotion failed before stale recovery");
      }
    }
    return { attempted, failed };
  }

  async function failStaleRun(snapshot: Run, thresholdMs: number) {
    const winner = await deps.withAgentStartLock(snapshot.agentId, () => withTxTimeout(deps.db, async (tx) => {
      const conn = tx as unknown as Db;
      const [current] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, snapshot.id),
        eq(heartbeatRuns.companyId, snapshot.companyId),
        eq(heartbeatRuns.agentId, snapshot.agentId),
        eq(heartbeatRuns.status, "queued"),
      )).for("update").limit(1);
      if (!current || !sameTime(current.createdAt, snapshot.createdAt) || !sameTime(current.updatedAt, snapshot.updatedAt)
        || current.issueId !== snapshot.issueId || current.wakeupRequestId !== snapshot.wakeupRequestId
        || !isPreStart(current) || !olderThan(current.createdAt, current.updatedAt, thresholdMs)
        || await hasCurrentExecution(current)) return null;

      if (current.issueId && (await operatorApprovalWaitService(conn).markerForIssue(current.issueId)).waiting) return null;
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, current.agentId), eq(agents.companyId, current.companyId),
      )).limit(1);
      if (!agent || await capacityIsPositivelyFull(conn, current.companyId, agent)) return null;

      const now = new Date();
      const message = `Queued heartbeat run exceeded ${Math.round(thresholdMs / 1000)}s without starting`;
      return deps.setRunStatus(conn, current.id, "failed", {
        error: message, errorCode: "stale_queued", finishedAt: now,
      }, { expectedStatuses: ["queued"], deferLiveEvent: true });
    }));
    if (winner) deps.publishRunStatus(winner);
    return winner;
  }

  async function failStaleOrphan(snapshot: typeof agentWakeupRequests.$inferSelect, thresholdMs: number) {
    return deps.withAgentStartLock(snapshot.agentId, () => withTxTimeout(deps.db, async (tx) => {
      const conn = tx as unknown as Db;
      const [current] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, snapshot.id),
        eq(agentWakeupRequests.companyId, snapshot.companyId),
        eq(agentWakeupRequests.agentId, snapshot.agentId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.runId),
      )).for("update").limit(1);
      if (!current || !sameTime(current.createdAt, snapshot.createdAt) || !sameTime(current.updatedAt, snapshot.updatedAt)
        || !olderThan(current.createdAt, current.updatedAt, thresholdMs)) return null;
      if (current.issueId && (await operatorApprovalWaitService(conn).markerForIssue(current.issueId)).waiting) return null;
      const [agent] = await tx.select().from(agents).where(and(
        eq(agents.id, current.agentId), eq(agents.companyId, current.companyId),
      )).limit(1);
      if (!agent || await capacityIsPositivelyFull(conn, current.companyId, agent)) return null;

      const cutoff = new Date(Date.now() - thresholdMs);
      const message = `stale_queued: queued wakeup exceeded ${Math.round(thresholdMs / 1000)}s without a heartbeat run (mission dedup without heartbeatRuns)`;
      const failed = await tx.update(agentWakeupRequests).set({
        status: "failed", error: message, finishedAt: new Date(), updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.id, current.id),
        eq(agentWakeupRequests.companyId, current.companyId),
        eq(agentWakeupRequests.agentId, current.agentId),
        eq(agentWakeupRequests.status, "queued"),
        isNull(agentWakeupRequests.runId),
        eq(agentWakeupRequests.updatedAt, snapshot.updatedAt),
        lt(agentWakeupRequests.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs linked WHERE linked.company_id = ${current.companyId} AND linked.agent_id = ${current.agentId} AND linked.wakeup_request_id = ${current.id})`,
      )).returning({ id: agentWakeupRequests.id }).then((rows) => rows[0] ?? null);
      return failed ? { current, message } : null;
    }));
  }

  return async function recoverQueuedStaleWork(thresholdMs: number) {
    const reapedRunIds: string[] = [];
    const orphanReapedIds: string[] = [];
    const queueStartAttempted = new Set<string>();
    const queueStartFailed = new Set<string>();
    if (thresholdMs <= 0) return { reapedRunIds };
    const queuedSnapshots = await deps.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"));
    const orphanSnapshots = await deps.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.status, "queued"), isNull(agentWakeupRequests.runId),
      lt(agentWakeupRequests.createdAt, new Date(Date.now() - thresholdMs)),
    ));
    const staleRuns = queuedSnapshots.filter((run) => olderThan(run.createdAt, run.updatedAt, thresholdMs));
    const staleOrphans = orphanSnapshots.filter((wake) => olderThan(wake.createdAt, wake.updatedAt, thresholdMs));

    for (const snapshot of staleRuns) {
      try {
        const failedRun = await failStaleRun(snapshot, thresholdMs);
        if (!failedRun) continue;
        reapedRunIds.push(failedRun.id);
        const now = new Date();
        const message = `Queued heartbeat run exceeded ${Math.round(thresholdMs / 1000)}s without starting`;
        if (failedRun.wakeupRequestId) {
          await deps.db.update(agentWakeupRequests).set({ status: "failed", finishedAt: now, error: message, updatedAt: now })
            .where(and(
              eq(agentWakeupRequests.id, failedRun.wakeupRequestId),
              eq(agentWakeupRequests.companyId, failedRun.companyId),
              eq(agentWakeupRequests.agentId, failedRun.agentId),
              or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, failedRun.id)),
              inArray(agentWakeupRequests.status, ["pending", "queued"]),
            ));
        }
        await deps.appendRunEvent(failedRun, await deps.nextRunEventSeq(failedRun.id), {
          eventType: "lifecycle", stream: "system", level: "error", message,
          payload: { queuedStaleThresholdMs: thresholdMs },
        });
        try {
          await deps.releaseIssueExecutionAndPromote(failedRun, { skipLocked: true });
        } catch (error) {
          logger.warn({ error, runId: failedRun.id }, "failed to release+promote stale queued run; continuing sweep");
        }
        const terminalRun = await deps.getRun(failedRun.id);
        if (terminalRun && ["succeeded", "failed", "cancelled", "timed_out"].includes(terminalRun.status)) {
          await deps.settleHeartbeatAfterExecution(deps.db, terminalRun, now).catch((error) => {
            logger.warn({ error, runId: terminalRun.id }, "failed to settle stale queued heartbeat");
          });
        }
        await deps.finalizeAgentStatus(failedRun.agentId, "failed");
        queueStartAttempted.add(failedRun.agentId);
        try {
          await deps.startNextQueuedRunForAgent(failedRun.agentId);
        } catch (error) {
          queueStartFailed.add(failedRun.agentId);
          throw error;
        }
      } catch (error) {
        logger.warn({ error, runId: snapshot.id }, "failed stale queued heartbeat recovery; continuing sweep");
      }
    }

    const promotion = await promoteOrphanCandidates(staleOrphans, queueStartAttempted, queueStartFailed);
    for (const snapshot of staleOrphans) {
      if (promotion.failed.has(snapshot.agentId)) continue;
      try {
        const failed = await failStaleOrphan(snapshot, thresholdMs);
        if (!failed) continue;
        await deps.recordQueueTransitionEvent({
          companyId: failed.current.companyId, issueId: failed.current.issueId,
          wakeupRequestId: failed.current.id, eventType: "wakeup_stale_queued", layer: "heartbeat",
          decision: "failed", reason: "stale_queued", reasonCode: "stale_queued",
          idempotencyKey: `wakeup-stale-queued:${failed.current.id}`,
          payload: { queuedStaleThresholdMs: thresholdMs, runId: null },
        });
        orphanReapedIds.push(failed.current.id);
      } catch (error) {
        logger.warn({ error, wakeupRequestId: snapshot.id }, "failed stale queued wake recovery; continuing sweep");
      }
    }

    if (orphanReapedIds.length) logger.warn({ orphanWakeupCount: orphanReapedIds.length, wakeupIds: orphanReapedIds }, "reaped stale queued wakeup requests without a heartbeat run");
    return { reapedRunIds };
  };
}
