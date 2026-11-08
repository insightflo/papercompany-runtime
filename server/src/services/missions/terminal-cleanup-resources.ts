import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  missionAgentRuntimes,
  workflowStepRuns,
} from "@paperclipai/db";
import type { MissionTerminalCleanupDb, MissionTerminalCleanupInput } from "./terminal-cleanup-fence.js";
import { ACTIVE_MISSION_RUNTIME_STATUSES } from "./mission-runtime-manager.js";
import { captureMissionTerminalProcesses } from "./terminal-cleanup-processes.js";
import { logger } from "../../middleware/logger.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import { lifecycleInFlightClause } from "../heartbeat-finalization/lifecycle-active.js";
import { ensureFinalization } from "../heartbeat-finalization/finalization-state.js";
import {
  decideHeartbeatTerminalOutcomeFirstWins,
  releaseExecutorOwnerCapability,
} from "../heartbeat-finalization/owner-capability.js";

const MISSION_TERMINAL_CLEANUP_SOURCE = "mission_terminal_cleanup";

type TerminalizedRun = typeof heartbeatRuns.$inferSelect;

/** [v1 finalization 계약] 미션 종료 정리가 run 을 종결할 때 terminal outcome 결정(first-wins),
 * finalization parent, executor owner release 를 반드시 기록한다. raw UPDATE 만 남기면
 * executor_owner_released_at 가 NULL 로 남아 quiescence 가 영구 실패하고(2026-11-07 A1 좀비 8건)
 * run 이 정산되지 않아 capacity 슬롯을 영구 점유한다. decide CAS 가 이미 결정된 outcome 에 지면
 * 그 결정을 그대로 보존한다(first-wins) — 종료 정리가 성공 증거를 덮어쓰지 않는다. */
async function recordMissionTerminalCleanupFinalization(
  executor: MissionTerminalCleanupDb,
  terminalized: TerminalizedRun,
  outcome: "succeeded" | "cancelled",
  now: Date,
): Promise<void> {
  const runId = terminalized.id;
  try {
    await decideHeartbeatTerminalOutcomeFirstWins(executor as unknown as Db, {
      run: terminalized,
      outcome,
      source: MISSION_TERMINAL_CLEANUP_SOURCE,
      now,
    });
    const [decided] = await executor.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    // decide CAS 가 지고 outcome 도 없으면(비정상 조합) release 근거가 없다 — recovery lane 에 맡긴다.
    if (!decided || decided.finalizationVersion !== 1 || decided.terminalOutcome === null) return;
    await ensureFinalization(executor as unknown as Db, decided, now);
    await releaseExecutorOwnerCapability(executor as unknown as Db, decided, now);
  } catch (err) {
    // finalization 기록 실패가 실제 종료 정리를 롤백하지 않는다(shadow-terminal-hook 과 같은 계약).
    logger.warn({ err, runId, outcome }, "mission terminal cleanup finalization recording failed");
  }
}

/** Bounded settlement only: no generic cancellation, release, promotion or dispatch. */
export async function settleMissionTerminalResources(
  executor: MissionTerminalCleanupDb,
  { companyId, missionId, status, now }: MissionTerminalCleanupInput,
) {
  const issueScope = and(eq(issues.companyId, companyId), eq(issues.missionId, missionId));
  // 같은 잠금 순서(id 오름차순 FOR UPDATE)를 유지한다. v1 계약 판정에 lease 식별·증거 칼럼이 필요하므로 전 행을 읽는다.
  const activeHeartbeats = await executor.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.issueId, executor.select({ id: issues.id }).from(issues).where(issueScope)),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  )).orderBy(heartbeatRuns.id).for("update");
  const processStops = captureMissionTerminalProcesses(activeHeartbeats);
  const error = `Cancelled because mission was ${status}`;
  if (activeHeartbeats.length) {
    const terminalized: TerminalizedRun[] = [];
    if (await isHeartbeatFinalizationV1Enabled(executor as unknown as Db)) {
      // [성공 보존] 정리 시점에 이미 성공 증거가 있는 run 은 cancelled 로 덮어쓰지 않는다:
      // (1) 먼저 결정된 terminal outcome(succeeded), (2) 완료된 workflow step run,
      // (3) 기록된 성공 결과(resultJson + exitCode 0). 실행 중이던 run 만 취소로 결정한다.
      const stepRunIds = activeHeartbeats
        .map((run) => run.workflowStepRunId)
        .filter((id): id is string => typeof id === "string");
      const completedStepRunIds = new Set(stepRunIds.length
        ? (await executor.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
          .where(and(inArray(workflowStepRuns.id, stepRunIds), eq(workflowStepRuns.status, "completed")))
        ).map((row) => row.id)
        : []);
      for (const run of activeHeartbeats) {
        const v1 = run.finalizationVersion === 1;
        const successEvidence = v1 && (
          run.terminalOutcome === "succeeded"
          || (run.workflowStepRunId !== null && completedStepRunIds.has(run.workflowStepRunId))
          || (run.resultJson !== null && (run.exitCode ?? 0) === 0)
        );
        const terminalStatus = successEvidence ? "succeeded" : "cancelled";
        const [updated] = await executor.update(heartbeatRuns).set(
          terminalStatus === "cancelled"
            ? { status: "cancelled", finishedAt: now, error, errorCode: "cancelled", updatedAt: now }
            : { status: "succeeded", finishedAt: now, updatedAt: now },
        ).where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, run.id),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        )).returning();
        if (!updated) continue;
        terminalized.push(updated);
        if (v1) {
          await recordMissionTerminalCleanupFinalization(executor, updated, terminalStatus, now);
        }
      }
    } else {
      // 플래그 OFF — 레거시 일괄 취소(바이트 동일 동작).
      const cancelled = await executor.update(heartbeatRuns).set({
        status: "cancelled", finishedAt: now, error, errorCode: "cancelled", updatedAt: now,
      }).where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.id, activeHeartbeats.map((run) => run.id)),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      )).returning();
      terminalized.push(...cancelled);
    }
    const terminalizedIds = terminalized.map((run) => run.id);
    for (const run of activeHeartbeats) {
      if (!run.wakeupRequestId || !terminalizedIds.includes(run.id)) continue;
      const succeeded = terminalized.find((row) => row.id === run.id)?.status === "succeeded";
      await executor.update(agentWakeupRequests).set(
        succeeded
          ? { status: "completed", finishedAt: now, updatedAt: now }
          : { status: "cancelled", finishedAt: now, error, updatedAt: now },
      ).where(and(
        eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, run.agentId),
        or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, run.id)),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
      ));
    }
    if (terminalizedIds.length) {
      await executor.update(issues).set({ checkoutRunId: null, updatedAt: now })
        .where(and(issueScope, inArray(issues.checkoutRunId, terminalizedIds)));
      await executor.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
        .where(and(issueScope, inArray(issues.executionRunId, terminalizedIds)));
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
  // [C2 2026-11-08] 표시 상태(idle 판정)와 슬롯 계산(countRunningRunsForAgent — lifecycleActiveClause)
  // 이 같은 기준을 쓴다. 미정산 terminal v1 run 도 점유로 센다 — 그 창구에 idle 로 덮어쓰면
  // 보드는 idle 인데 슬롯이 점유된 불일치가 생긴다(2026-11-07 A1 관측). 플래그 OFF 시
  // 기존 queued/running 판정과 바이트 동일하다.
  const inFlight = await lifecycleInFlightClause(executor);
  const remainingHeartbeats = await executor.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, affectedAgentIds),
    inFlight,
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
