import { inArray } from "drizzle-orm";
import { missions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { CadenceVerdict } from "./mission-oversight-cadence.js";
import { evaluateMissionOversightForMission } from "./mission-oversight-shadow.js";

export type MissionOversightLivenessGhostWakeRequestedHandler = (input: {
  mission: { id: string; companyId: string; ownerAgentId: string };
  verdict: Pick<CadenceVerdict, "state" | "triggerKind" | "reasonCode">;
  computedTimestamps: CadenceVerdict["computedTimestamps"];
  idempotencyKey: string;
}) => Promise<void>;

interface LivenessLaneOptions {
  livenessLaneIntervalMs?: number;
  onMissionOversightLivenessGhostWakeRequested: MissionOversightLivenessGhostWakeRequestedHandler;
}
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const BUCKET_MS = 2 * 60 * 60_000;
const WAKE_EVENT = "mission_oversight_liveness_wake";

/** Request an owner inspection, never retry/reassign or mutate execution state.
 * As in the failure lane, durable claims precede delivery and survive delivery
 * failure. The independent supervision/review paths remain the fallback.
 */
export function createMissionOversightLivenessLane(db: Db, options: LivenessLaneOptions) {
  const intervalMs = Math.max(1, options.livenessLaneIntervalMs ?? DEFAULT_INTERVAL_MS);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lifecycle = 0;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    const epoch = lifecycle;
    const now = new Date();
    try {
      const active = await db.select({ id: missions.id, companyId: missions.companyId, ownerAgentId: missions.ownerAgentId })
        .from(missions).where(inArray(missions.status, ["active", "planning"]));
      if (epoch !== lifecycle) return;
      for (const mission of active) {
        if (epoch !== lifecycle) return;
        if (!mission.ownerAgentId) continue;
        try {
          const verdict = await evaluateMissionOversightForMission(db, mission.companyId, mission.id, now);
          if (epoch !== lifecycle) return;
          if (verdict?.state !== "RUNNING" || verdict.triggerKind !== "liveness_ghost") continue;
          const idempotencyKey = `mission-oversight-liveness:${mission.id}:${Math.floor(now.getTime() / BUCKET_MS)}`;
          const computedTimestamps = verdict.computedTimestamps;
          // The company-scoped partial unique index arbitrates other processes
          // and restarts; local timer state is not deduplication authority.
          const claimed = await db.insert(workflowTransitionEvents).values({ companyId: mission.companyId, missionId: mission.id,
            eventType: WAKE_EVENT, layer: "mission_owner_recovery", idempotencyKey,
            payload: { schemaVersion: 1, kind: WAKE_EVENT, state: verdict.state, triggerKind: verdict.triggerKind,
              reasonCode: verdict.reasonCode, computedTimestamps },
          }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
          if (epoch !== lifecycle) return;
          if (claimed.length) await options.onMissionOversightLivenessGhostWakeRequested({ mission,
            verdict: { state: verdict.state, triggerKind: verdict.triggerKind, reasonCode: verdict.reasonCode },
            computedTimestamps, idempotencyKey });
        } catch (err) {
          logger.warn({ err, companyId: mission.companyId, missionId: mission.id }, "Mission oversight liveness lane mission failed");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Mission oversight liveness lane tick failed");
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      lifecycle++; // Fence already-awaiting ticks before they can wake an owner.
    },
    run,
  };
}
