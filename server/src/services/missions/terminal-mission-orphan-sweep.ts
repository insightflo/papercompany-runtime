import { and, eq, inArray, lt } from "drizzle-orm";
import { activityLog, heartbeatRuns, issues, missionAgentRuntimes, missions, type Db } from "@paperclipai/db";
import { ACTIVE_MISSION_RUNTIME_STATUSES } from "./mission-runtime-manager.js";
import { runMissionTerminalCleanup } from "./terminal-cleanup-fence.js";

/**
 * [purpose] Slice-5 MISMATCH D: crash windows, missed transitions, and server restarts can
 *   leave queued/running heartbeat runs or active mission_agent_runtimes under missions that
 *   are ALREADY terminal. This sweep re-finalizes those missions through the same atomic
 *   terminal-cleanup fence (runs end cancelled-with-reason, locks clear, runtimes stop) —
 *   a state change, not a report. Idempotent: nothing active means nothing to do.
 * [safety] The fence re-checks mission status under its own locks and aborts safely
 *   (resume_reactivated) when a mission resumed between candidate scan and cleanup.
 */
export interface TerminalMissionOrphanSweepResult {
  sweptMissions: number;
  cancelledRuns: number;
  stoppedRuntimes: number;
}

const SWEEP_BATCH_LIMIT = 25;

async function countActiveRuns(db: Db, missionId: string): Promise<number> {
  return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(issues, eq(issues.id, heartbeatRuns.issueId))
    .where(and(eq(issues.missionId, missionId), inArray(heartbeatRuns.status, ["queued", "running"])))
    .then((rows) => rows.length);
}

export async function sweepTerminalMissionOrphanRuns(
  db: Db,
  now: Date,
  graceMs = 10 * 60_000,
): Promise<TerminalMissionOrphanSweepResult> {
  const cutoff = new Date(now.getTime() - graceMs);

  const runCandidates = await db.selectDistinct({ missionId: issues.missionId })
    .from(heartbeatRuns)
    .innerJoin(issues, eq(issues.id, heartbeatRuns.issueId))
    .innerJoin(missions, eq(missions.id, issues.missionId))
    .where(and(
      inArray(heartbeatRuns.status, ["queued", "running"]),
      lt(heartbeatRuns.updatedAt, cutoff),
      inArray(missions.status, ["completed", "cancelled"]),
    ));
  const runtimeCandidates = await db.selectDistinct({ missionId: missionAgentRuntimes.missionId })
    .from(missionAgentRuntimes)
    .innerJoin(missions, eq(missions.id, missionAgentRuntimes.missionId))
    .where(and(
      inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
      lt(missionAgentRuntimes.updatedAt, cutoff),
      inArray(missions.status, ["completed", "cancelled"]),
    ));
  const missionIds = Array.from(new Set(
    [...runCandidates, ...runtimeCandidates]
      .map((row) => row.missionId)
      .filter((id): id is string => typeof id === "string"),
  )).slice(0, SWEEP_BATCH_LIMIT);

  let sweptMissions = 0;
  let cancelledRuns = 0;
  let stoppedRuntimes = 0;

  for (const missionId of missionIds) {
    const [fresh] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!fresh || (fresh.status !== "completed" && fresh.status !== "cancelled")) continue;

    const activeRunCount = await countActiveRuns(db, missionId);
    const activeRuntimes = await db.select({ id: missionAgentRuntimes.id }).from(missionAgentRuntimes)
      .where(and(
        eq(missionAgentRuntimes.missionId, missionId),
        inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
      ));
    if (activeRunCount === 0 && activeRuntimes.length === 0) continue;

    const settled = await runMissionTerminalCleanup(db, {
      companyId: fresh.companyId,
      missionId,
      status: fresh.status,
      now,
      completedAt: fresh.completedAt,
      missionSnapshot: fresh,
    });
    if (settled.aborted) continue;

    const runsRemaining = await countActiveRuns(db, missionId);
    const runsCancelled = Math.max(0, activeRunCount - runsRemaining);
    const runtimesStopped = settled.stoppedRuntimeIds.length;

    if (runsCancelled > 0 || runtimesStopped > 0) {
      sweptMissions += 1;
      cancelledRuns += runsCancelled;
      stoppedRuntimes += runtimesStopped;
      await db.insert(activityLog).values({
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "native-reconciler",
        action: "mission.orphan_terminal_cleanup_swept",
        entityType: "mission",
        entityId: missionId,
        details: { status: fresh.status, cancelledRuns: runsCancelled, stoppedRuntimes: runtimesStopped },
      });
    }
  }

  return { sweptMissions, cancelledRuns, stoppedRuntimes };
}
