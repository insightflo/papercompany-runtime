import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  listDueScheduledWorkflowCandidates,
  type ComputeDueScheduledWorkflowCandidatesOptions,
  type ScheduledWorkflowCandidate,
} from "./scheduler-candidates.js";
import { workflowService } from "./engine.js";
import { processQueuedWorkflowToolStepRuns, type WorkflowToolStepQueueDispatchResult } from "./dag-engine.js";
import {
  AGENT_FIT_REFRESH_INTERVAL_MS,
  refreshAgentFitProfiles,
} from "../agent-fit-evaluator.js";
import { logger as defaultLogger } from "../../middleware/logger.js";

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_TOOL_STEP_QUEUE_INTERVAL_MS = 10_000;
const DEFAULT_FIT_PROFILE_INTERVAL_MS = AGENT_FIT_REFRESH_INTERVAL_MS;

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
  lastToolStepClaimedCount: number;
  lastToolStepExecutedCount: number;
  lastToolStepFailedCount: number;
  fitProfileArmed: boolean;
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
  toolStepQueueIntervalMs?: number;
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
  dispatchQueuedToolSteps?: (
    db: Db,
    options?: { limit?: number; now?: Date },
  ) => Promise<WorkflowToolStepQueueDispatchResult>;
  refreshFitProfiles?: (db: Db, options?: { now?: Date }) => Promise<{ updatedCount: number; skippedFreshCount: number }>;
  /** [agent fit activity gate] 런 활동 지표(저렴한 프로브). 기본: heartbeat_runs count+max(updated_at). */
  readRunActivitySignature?: (db: Db) => Promise<string>;
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
  const toolStepQueueIntervalMs = options.toolStepQueueIntervalMs ?? DEFAULT_TOOL_STEP_QUEUE_INTERVAL_MS;
  const listCandidates = options.listCandidates ?? listDueScheduledWorkflowCandidates;
  const claimScheduledRun = options.claimScheduledRun ?? workflowService.claimScheduledRun;
  const dispatchQueuedToolSteps = options.dispatchQueuedToolSteps ?? processQueuedWorkflowToolStepRuns;
  const refreshFitProfiles = options.refreshFitProfiles ?? refreshAgentFitProfiles;
  const readRunActivitySignature = options.readRunActivitySignature ?? defaultReadRunActivitySignature;
  const log = options.logger ?? defaultLogger;
  let interval: ReturnType<typeof setInterval> | null = null;
  let toolStepQueueInterval: ReturnType<typeof setInterval> | null = null;
  let fitProfileInterval: ReturnType<typeof setInterval> | null = null;
  let fitProfileTickInFlight = false;
  // [activity-driven fit scheduler] 런 활동 서명 — 런이 있으면 10분 스케줄 유지,
  //   한 주기 동안 새 런이 없으면 스케줄 자기중단(disarm), 다음 런 활동이 재가동(arm).
  let fitProfileActivitySignature: string | null = null;
  let tickInFlight = false;
  let toolStepQueueTickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastCandidateCount = 0;
  let lastClaimedCount = 0;
  let lastSkippedCount = 0;
  let lastErrorCount = 0;
  let lastToolStepClaimedCount = 0;
  let lastToolStepExecutedCount = 0;
  let lastToolStepFailedCount = 0;

  async function dispatchToolStepQueue(now = new Date()): Promise<WorkflowToolStepQueueDispatchResult> {
    if (options.mode !== "active") {
      return { claimedCount: 0, executedCount: 0, failedCount: 0, skippedCount: 0 };
    }
    if (toolStepQueueTickInFlight) {
      log.warn({ mode: options.mode }, "Native workflow tool-step queue tick skipped because previous tick is still running");
      return { claimedCount: 0, executedCount: 0, failedCount: 0, skippedCount: 1 };
    }

    toolStepQueueTickInFlight = true;
    try {
      const result = await dispatchQueuedToolSteps(options.db, { now });
      lastToolStepClaimedCount = result.claimedCount;
      lastToolStepExecutedCount = result.executedCount;
      lastToolStepFailedCount = result.failedCount;
      return result;
    } catch (error) {
      lastToolStepClaimedCount = 0;
      lastToolStepExecutedCount = 0;
      lastToolStepFailedCount = 1;
      log.error({
        mode: options.mode,
        err: error instanceof Error ? error.message : String(error),
      }, "Native workflow scheduler failed to dispatch queued workflow tool steps");
      return { claimedCount: 0, executedCount: 0, failedCount: 1, skippedCount: 0 };
    } finally {
      toolStepQueueTickInFlight = false;
    }
  }

  async function defaultReadRunActivitySignature(db: Db): Promise<string> {
    const result = await db.execute(sql`SELECT count(*)::text AS c, COALESCE(max(updated_at)::text, '') AS m FROM heartbeat_runs`);
    const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? (result as unknown as Record<string, unknown>[]);
    const row = rows[0] ?? {};
    return `${row.c ?? "0"}:${row.m ?? ""}`;
  }

  function armFitProfileInterval(): void {
    if (fitProfileInterval) return;
    fitProfileInterval = setInterval(() => {
      void dispatchFitProfileRefresh();
    }, DEFAULT_FIT_PROFILE_INTERVAL_MS);
    fitProfileInterval.unref?.();
  }

  function disarmFitProfileInterval(): void {
    if (fitProfileInterval) {
      clearInterval(fitProfileInterval);
      fitProfileInterval = null;
    }
  }

  async function dispatchFitProfileRefresh(now = new Date()): Promise<void> {
    if (options.mode !== "active") return;
    if (fitProfileTickInFlight) return;
    fitProfileTickInFlight = true;
    try {
      const signature = await readRunActivitySignature(options.db);
      // 부트스트랩: 첫 관찰은 서명만 확보하고 즉시 평가(재시작 후 따라잡기).
      if (fitProfileActivitySignature === null) {
        fitProfileActivitySignature = signature;
        const result = await refreshFitProfiles(options.db, { now });
        if (result.updatedCount > 0) {
          log.info({ mode: options.mode, updatedCount: result.updatedCount, skippedFreshCount: result.skippedFreshCount }, "Native scheduler refreshed agent fit profiles (bootstrap)");
        }
        return;
      }
      // [run-driven on/off] 이번 주기에 새 런 활동이 없으면 스케줄을 끈다 — 불필요한 스케줄 실행 방지.
      //   재가동은 메인 틱(60s)의 활동 프로브가 담당한다.
      if (signature === fitProfileActivitySignature) {
        disarmFitProfileInterval();
        log.info({ mode: options.mode }, "Native scheduler agent fit profile schedule disarmed (no run activity since last evaluation)");
        return;
      }
      fitProfileActivitySignature = signature;
      const result = await refreshFitProfiles(options.db, { now });
      if (result.updatedCount > 0) {
        log.info({
          mode: options.mode,
          updatedCount: result.updatedCount,
          skippedFreshCount: result.skippedFreshCount,
        }, "Native scheduler refreshed agent fit profiles");
      }
    } catch (error) {
      log.warn({
        mode: options.mode,
        err: error instanceof Error ? error.message : String(error),
      }, "Native scheduler agent fit profile refresh failed (observation lane, non-fatal)");
    } finally {
      fitProfileTickInFlight = false;
    }
  }

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
        let toolStepQueueResult: WorkflowToolStepQueueDispatchResult = {
          claimedCount: 0,
          executedCount: 0,
          failedCount: 0,
          skippedCount: 0,
        };

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

        toolStepQueueResult = await dispatchToolStepQueue(now);

        // [agent fit re-arm] 런 활동이 생겼는데 fit 스케줄이 꺼져 있으면 다시 켠다.
        //   (fit 틱 자신은 조용한 주기에 자기자신을 끈다 — 런이 스케줄을 켜고 끈다.)
        if (!fitProfileInterval) {
          try {
            const signature = await readRunActivitySignature(options.db);
            if (fitProfileActivitySignature === null || signature !== fitProfileActivitySignature) {
              armFitProfileInterval();
              void dispatchFitProfileRefresh();
            }
          } catch {
            // 활동 프로브 실패는 재가동 스킵 — 다음 틱이 재시도
          }
        }

        lastClaimedCount = claimedCount;
        lastSkippedCount = skippedCount;
        lastErrorCount = errorCount;
        lastToolStepClaimedCount = toolStepQueueResult.claimedCount;
        lastToolStepExecutedCount = toolStepQueueResult.executedCount;
        lastToolStepFailedCount = toolStepQueueResult.failedCount;
        log.info({
          mode: options.mode,
          candidateCount: candidates.length,
          claimedCount,
          skippedCount,
          errorCount,
          toolStepClaimedCount: toolStepQueueResult.claimedCount,
          toolStepExecutedCount: toolStepQueueResult.executedCount,
          toolStepFailedCount: toolStepQueueResult.failedCount,
          toolStepSkippedCount: toolStepQueueResult.skippedCount,
          candidates: candidates.map(serializeCandidate),
        }, "Native workflow scheduler active tick");
        return;
      }

      lastClaimedCount = 0;
      lastSkippedCount = 0;
      lastErrorCount = 0;
      lastToolStepClaimedCount = 0;
      lastToolStepExecutedCount = 0;
      lastToolStepFailedCount = 0;
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
      if (options.mode === "active") {
        toolStepQueueInterval = setInterval(() => {
          void dispatchToolStepQueue().then((result) => {
            if (
              result.claimedCount === 0
              && result.executedCount === 0
              && result.failedCount === 0
              && result.skippedCount === 0
            ) return;
            log.info({
              mode: options.mode,
              claimedCount: result.claimedCount,
              executedCount: result.executedCount,
              failedCount: result.failedCount,
              skippedCount: result.skippedCount,
            }, "Native workflow tool-step queue tick");
          });
        }, toolStepQueueIntervalMs);
        toolStepQueueInterval.unref?.();
        // [agent fit observation] 런 종료 후 수 분 내 자동 누계·제안 계산 (metadata 관찰 전용,
        //   실패해도 어떤 실행 경로에도 영향 없음). 활동 구동: 조용하면 자기중단.
        armFitProfileInterval();
        void dispatchFitProfileRefresh();
      }
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (toolStepQueueInterval) {
        clearInterval(toolStepQueueInterval);
        toolStepQueueInterval = null;
      }
      disarmFitProfileInterval();
      log.info({ mode: options.mode }, "Native workflow scheduler stopped");
    },
    tick,
    getState() {
      return {
        running: interval !== null || toolStepQueueInterval !== null,
        tickCount,
        lastTickAt,
        lastCandidateCount,
        lastClaimedCount,
        lastSkippedCount,
        lastErrorCount,
        lastToolStepClaimedCount,
        lastToolStepExecutedCount,
        lastToolStepFailedCount,
        fitProfileArmed: fitProfileInterval !== null,
      };
    },
  };
}
