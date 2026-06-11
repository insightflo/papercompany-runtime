import type { Db } from "@paperclipai/db";
import {
  listDueScheduledWorkflowCandidates,
  type ComputeDueScheduledWorkflowCandidatesOptions,
  type ScheduledWorkflowCandidate,
} from "./scheduler-candidates.js";
import { workflowService } from "./engine.js";
import { logger as defaultLogger } from "../../middleware/logger.js";

const DEFAULT_TICK_INTERVAL_MS = 60_000;

export type NativeWorkflowSchedulerMode = "shadow" | "active";

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
  lastClaimedCount: number;
  lastSkippedCount: number;
  lastErrorCount: number;
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
  claimScheduledRun?: (
    db: Db,
    input: {
      workflowId: string;
      companyId: string;
      scheduledAt: Date;
      runDate: string;
      timezone: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<{ claimed: boolean }>;
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
  const claimScheduledRun = options.claimScheduledRun ?? workflowService.claimScheduledRun;
  const log = options.logger ?? defaultLogger;
  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastCandidateCount = 0;
  let lastClaimedCount = 0;
  let lastSkippedCount = 0;
  let lastErrorCount = 0;

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

      if (options.mode === "active") {
        let claimedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const candidate of candidates) {
          try {
            const result = await claimScheduledRun(options.db, {
              workflowId: candidate.workflowId,
              companyId: candidate.companyId,
              scheduledAt: candidate.scheduledAt,
              runDate: candidate.runDate,
              timezone: candidate.timezone,
              metadata: {
                schedule: candidate.schedule,
                workflowName: candidate.workflowName,
              },
            });
            if (result.claimed) {
              claimedCount += 1;
            } else {
              skippedCount += 1;
            }
          } catch (error) {
            errorCount += 1;
            log.error({
              mode: options.mode,
              workflowId: candidate.workflowId,
              companyId: candidate.companyId,
              scheduledAt: candidate.scheduledAt.toISOString(),
              err: error instanceof Error ? error.message : String(error),
            }, "Native workflow scheduler failed to claim due workflow");
          }
        }

        lastClaimedCount = claimedCount;
        lastSkippedCount = skippedCount;
        lastErrorCount = errorCount;
        log.info({
          mode: options.mode,
          candidateCount: candidates.length,
          claimedCount,
          skippedCount,
          errorCount,
          candidates: candidates.map(serializeCandidate),
        }, "Native workflow scheduler active tick");
        return;
      }

      lastClaimedCount = 0;
      lastSkippedCount = 0;
      lastErrorCount = 0;
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
        lastClaimedCount,
        lastSkippedCount,
        lastErrorCount,
      };
    },
  };
}
