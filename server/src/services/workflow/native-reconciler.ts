import type { Db } from "@paperclipai/db";
import { logger as defaultLogger } from "../../middleware/logger.js";
import { reconcileWorkflow } from "./reconciler.js";
import { recoverTerminalUnsettledRuns } from "../heartbeat-finalization/recovery.js";
import { reconcileProvider403LadderWakeups } from "../heartbeat-provider403-ladder.js";

export interface NativeWorkflowReconcilerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface NativeWorkflowReconcilerState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastRunnableStepWakeupsQueued: number;
  lastDeadlockedRunsRecovered: number;
  lastStuckRunsRecovered: number;
  lastOrphanStepsCleaned: number;
  lastError: string | null;
}

export interface NativeWorkflowReconciler {
  start: () => void;
  stop: () => void;
  reconcile: (now?: Date) => Promise<void>;
  getState: () => NativeWorkflowReconcilerState;
}

export interface CreateNativeWorkflowReconcilerOptions {
  db: Db;
  timeoutMinutes?: number;
  intervalMs?: number;
  logger?: NativeWorkflowReconcilerLogger;
}

const DEFAULT_RECONCILER_INTERVAL_MS = 5 * 60_000;

export function createNativeWorkflowReconciler(
  options: CreateNativeWorkflowReconcilerOptions,
): NativeWorkflowReconciler {
  const intervalMs = options.intervalMs ?? DEFAULT_RECONCILER_INTERVAL_MS;
  const timeoutMinutes = options.timeoutMinutes ?? 60;
  const log = options.logger ?? defaultLogger;
  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastRunnableStepWakeupsQueued = 0;
  let lastDeadlockedRunsRecovered = 0;
  let lastStuckRunsRecovered = 0;
  let lastOrphanStepsCleaned = 0;
  let lastError: string | null = null;

  async function reconcile(now = new Date()): Promise<void> {
    if (tickInFlight) {
      log.warn({ timeoutMinutes }, "Native workflow reconciler tick skipped because previous tick is still running");
      return;
    }
    tickInFlight = true;
    try {
      const result = await reconcileWorkflow(options.db, { timeoutMinutes });
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastRunnableStepWakeupsQueued = result.runnableStepWakeupsQueued;
      lastDeadlockedRunsRecovered = result.deadlockedRunsRecovered;
      lastStuckRunsRecovered = result.stuckRunsRecovered;
      lastOrphanStepsCleaned = result.orphanStepsCleaned;
      lastError = null;
      if (
        result.runnableStepWakeupsQueued > 0
        || result.deadlockedRunsRecovered > 0
        || result.stuckRunsRecovered > 0
        || result.orphanStepsCleaned > 0
      ) {
        log.info({ timeoutMinutes, ...result }, "Native workflow reconciler cleaned up workflow state");
      }
      // Phase 3 recovery: replay settlement for terminal-but-unsettled v1 runs.
      const recoveredSettlements = await recoverTerminalUnsettledRuns(options.db, now);
      if (recoveredSettlements > 0) {
        log.info({ timeoutMinutes, recoveredSettlements }, "Native workflow reconciler recovered terminal-unsettled finalizations");
      }
      // [provider 403 ladder] 종단 403 지점의 bounded backoff scheduled wake. 실패해도 reconciler tick 은 깨지지 않는다.
      try {
        const ladder = await reconcileProvider403LadderWakeups(options.db, { now });
        if (ladder.scheduled > 0) {
          log.info({ scheduled: ladder.scheduled }, "Provider 403 backoff ladder wakeups scheduled");
        }
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Provider 403 backoff ladder scan failed",
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ timeoutMinutes, err: lastError }, "Native workflow reconciler tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({ timeoutMinutes, intervalMs }, "Native workflow reconciler started");
      void reconcile();
      interval = setInterval(() => void reconcile(), intervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      log.info({ timeoutMinutes }, "Native workflow reconciler stopped");
    },
    reconcile,
    getState() {
      return {
        running: interval !== null,
        tickCount,
        lastTickAt,
        lastRunnableStepWakeupsQueued,
        lastDeadlockedRunsRecovered,
        lastStuckRunsRecovered,
        lastOrphanStepsCleaned,
        lastError,
      };
    },
  };
}
