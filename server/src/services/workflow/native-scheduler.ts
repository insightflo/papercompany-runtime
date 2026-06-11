import type { Db } from "@paperclipai/db";
import {
  listDueScheduledWorkflowCandidates,
  type ComputeDueScheduledWorkflowCandidatesOptions,
  type ScheduledWorkflowCandidate,
} from "./scheduler-candidates.js";
import { logger as defaultLogger } from "../../middleware/logger.js";

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export type NativeWorkflowSchedulerMode = "shadow";

export interface NativeWorkflowSchedulerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface NativeWorkflowSchedulerState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastCandidateCount: number;
}

export interface NativeWorkflowScheduler {
  start: () => void;
  stop: () => void;
  tick: (now?: Date) => Promise<void>;
  getState: () => NativeWorkflowSchedulerState;
}

export interface CreateNativeWorkflowSchedulerOptions {
  db: Db;
  mode: NativeWorkflowSchedulerMode;
  tickIntervalMs?: number;
  listCandidates?: (
    db: Db,
    options?: ComputeDueScheduledWorkflowCandidatesOptions,
  ) => Promise<ScheduledWorkflowCandidate[]>;
  logger?: NativeWorkflowSchedulerLogger;
}

function serializeCandidate(candidate: ScheduledWorkflowCandidate): Record<string, unknown> {
  return {
    workflowId: candidate.workflowId,
    companyId: candidate.companyId,
    workflowName: candidate.workflowName,
    schedule: candidate.schedule,
    timezone: candidate.timezone,
    scheduledAt: candidate.scheduledAt.toISOString(),
    runDate: candidate.runDate,
  };
}

export function createNativeWorkflowScheduler(
  options: CreateNativeWorkflowSchedulerOptions,
): NativeWorkflowScheduler {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const listCandidates = options.listCandidates ?? listDueScheduledWorkflowCandidates;
  const log = options.logger ?? defaultLogger;
  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastCandidateCount = 0;

  async function tick(now = new Date()): Promise<void> {
    if (tickInFlight) {
      log.warn({ mode: options.mode }, "Native workflow scheduler tick skipped because previous tick is still running");
      return;
    }

    tickInFlight = true;
    try {
      const candidates = await listCandidates(options.db, { now });
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastCandidateCount = candidates.length;

      log.info({
        mode: options.mode,
        candidateCount: candidates.length,
        candidates: candidates.map(serializeCandidate),
      }, "Native workflow scheduler shadow tick");
    } catch (error) {
      log.error({
        mode: options.mode,
        err: error instanceof Error ? error.message : String(error),
      }, "Native workflow scheduler tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({
        mode: options.mode,
        tickIntervalMs,
      }, "Native workflow scheduler started");
      void tick();
      interval = setInterval(() => {
        void tick();
      }, tickIntervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      log.info({ mode: options.mode }, "Native workflow scheduler stopped");
    },
    tick,
    getState() {
      return {
        running: interval !== null,
        tickCount,
        lastTickAt,
        lastCandidateCount,
      };
    },
  };
}
