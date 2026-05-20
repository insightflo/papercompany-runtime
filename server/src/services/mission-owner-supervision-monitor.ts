import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { missionService, type MissionOwnerActionCreatedHandler } from "./missions.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_STALE_AFTER_MINUTES = 30;

export interface MissionOwnerSupervisionMonitorOptions {
  intervalMs?: number;
  staleAfterMinutes?: number;
  runImmediately?: boolean;
  applySafeActions?: boolean;
  onOwnerActionCreated?: MissionOwnerActionCreatedHandler;
}

export function createMissionOwnerSupervisionMonitor(
  db: Db,
  options: MissionOwnerSupervisionMonitorOptions = {},
) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const staleAfterMinutes = Math.max(1, options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES);
  const runImmediately = options.runImmediately ?? true;
  const applySafeActions = options.applySafeActions ?? true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await missionService(db, {
        onOwnerActionCreated: options.onOwnerActionCreated,
      }).runActiveMissionOwnerSupervision({
        staleAfterMinutes,
        applySafeActions,
      });
      const findingsCount = result.missions.reduce((total, mission) => total + mission.findings.length, 0);
      const commentedCount = result.missions.filter((mission) => mission.commented).length;
      const appliedActionsCount = result.missions.reduce((total, mission) => total + mission.appliedActions.length, 0);
      if (findingsCount > 0 || commentedCount > 0 || appliedActionsCount > 0) {
        logger.warn(
          {
            missionIds: result.missionIds,
            findingsCount,
            commentedCount,
            appliedActionsCount,
          },
          "Mission owner supervision monitor observed active mission issues",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Mission owner supervision monitor sweep failed");
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), intervalMs);
      if (runImmediately) void run();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    run,
  };
}

export type MissionOwnerSupervisionMonitor = ReturnType<typeof createMissionOwnerSupervisionMonitor>;
