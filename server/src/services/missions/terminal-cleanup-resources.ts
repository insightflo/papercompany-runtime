import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, agentRuntimeState, agentWakeupRequests, heartbeatRuns, issues, missionAgentRuntimes } from "@paperclipai/db";
import type { MissionTerminalCleanupDb, MissionTerminalCleanupInput } from "./terminal-cleanup-fence.js";
import { ACTIVE_MISSION_RUNTIME_STATUSES } from "./mission-runtime-manager.js";
import { captureMissionTerminalProcesses } from "./terminal-cleanup-processes.js";

/** Bounded settlement only: no generic cancellation, release, promotion or dispatch. */
export async function settleMissionTerminalResources(
  executor: MissionTerminalCleanupDb,
  { companyId, missionId, status, now }: MissionTerminalCleanupInput,
) {
  const issueScope = and(eq(issues.companyId, companyId), eq(issues.missionId, missionId));
  const activeHeartbeats = await executor.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    wakeupRequestId: heartbeatRuns.wakeupRequestId, processPid: heartbeatRuns.processPid,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.issueId, executor.select({ id: issues.id }).from(issues).where(issueScope)),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  )).orderBy(heartbeatRuns.id).for("update");
  const processStops = captureMissionTerminalProcesses(activeHeartbeats);
  const error = `Cancelled because mission was ${status}`;
  if (activeHeartbeats.length) {
    const cancelled = await executor.update(heartbeatRuns).set({
      status: "cancelled", finishedAt: now, error, errorCode: "cancelled", updatedAt: now,
    }).where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.id, activeHeartbeats.map((run) => run.id)),
      inArray(heartbeatRuns.status, ["queued", "running"]),
    )).returning({ id: heartbeatRuns.id });
    const cancelledIds = cancelled.map((run) => run.id);
    for (const run of activeHeartbeats) {
      if (!run.wakeupRequestId || !cancelledIds.includes(run.id)) continue;
      await executor.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, error, updatedAt: now })
        .where(and(
          eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, run.agentId),
          or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, run.id)),
          inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
        ));
    }
    if (cancelledIds.length) {
      await executor.update(issues).set({ checkoutRunId: null, updatedAt: now })
        .where(and(issueScope, inArray(issues.checkoutRunId, cancelledIds)));
      await executor.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
        .where(and(issueScope, inArray(issues.executionRunId, cancelledIds)));
    }
  }

  if (status === "cancelled") {
    await executor.update(issues).set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(issueScope, sql`${issues.status} not in ('done', 'cancelled')`));
  }

  const runtimeScope = and(eq(missionAgentRuntimes.companyId, companyId), eq(missionAgentRuntimes.missionId, missionId),
    inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]));
  const runtimes = await executor.select({ id: missionAgentRuntimes.id, processPid: missionAgentRuntimes.processPid })
    .from(missionAgentRuntimes).where(runtimeScope).orderBy(missionAgentRuntimes.id).for("update");
  const stoppedRuntimeIds: string[] = [];
  for (const runtime of runtimes) {
    const stopReason = `mission.${status}`;
    const statePatch = { stopReason, ...(runtime.processPid !== null ? {
      processTermination: [{ id: runtime.id, attempted: false, reason: "unverified_process_identity" }],
    } : {}) };
    const stopped = await executor.update(missionAgentRuntimes).set({
      status: "stopped", currentIssueId: null, queueDepth: 0, stopReason, stoppedAt: now, updatedAt: now,
      stateJson: sql`${missionAgentRuntimes.stateJson} || ${JSON.stringify(statePatch)}::jsonb`,
    }).where(and(runtimeScope, eq(missionAgentRuntimes.id, runtime.id))).returning({ id: missionAgentRuntimes.id });
    stoppedRuntimeIds.push(...stopped.map((row) => row.id));
  }
  return { stoppedRuntimeIds, processStops };
}

/** Global session state is shared across missions; reset only agents with no remaining work. */
export async function resetSafeTerminalAgents(
  executor: MissionTerminalCleanupDb, companyId: string, affectedAgentIds: string[], now: Date,
): Promise<void> {
  if (!affectedAgentIds.length) return;
  const remainingHeartbeats = await executor.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, affectedAgentIds),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  ));
  const remainingRuntimes = await executor.select({ agentId: missionAgentRuntimes.agentId }).from(missionAgentRuntimes).where(and(
    eq(missionAgentRuntimes.companyId, companyId), inArray(missionAgentRuntimes.agentId, affectedAgentIds),
    inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
  ));
  const busy = new Set([...remainingHeartbeats, ...remainingRuntimes].map((row) => row.agentId));
  const safe = affectedAgentIds.filter((id) => !busy.has(id));
  if (!safe.length) return;
  await executor.update(agents).set({ status: "idle", updatedAt: now }).where(and(
    eq(agents.companyId, companyId), inArray(agents.id, safe), inArray(agents.status, ["running", "error"]),
  ));
  await executor.update(agentRuntimeState).set({ lastError: null, sessionId: null, updatedAt: now }).where(and(
    eq(agentRuntimeState.companyId, companyId), inArray(agentRuntimeState.agentId, safe),
  ));
}
