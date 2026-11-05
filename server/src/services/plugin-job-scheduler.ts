/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Before dispatching a job, the scheduler checks
 *    for an existing `running` run for the same job. If one exists, the job
 *    is skipped for that tick.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginJobs, pluginJobRuns } from "@paperclipai/db";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";
import { executeQueuedPluginJob } from "./plugin-job-replay.js";
import { runtimeExecutionLifecycle, type RuntimeExecutionLifecycle } from "./runtime-execution-lifecycle.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
export interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
  /** Scheduled plugin jobs to suppress while another native owner handles the work. */
  disabledScheduledJobs?: DisabledScheduledPluginJob[];
  /** Process shutdown fence; injectable for deterministic boundary tests. */
  runtimeLifecycle?: RuntimeExecutionLifecycle;
}

export interface DisabledScheduledPluginJob {
  pluginKey: string;
  jobKey: string;
}

export function isScheduledPluginJobDisabled(
  job: { pluginKey: string; jobKey: string },
  disabledScheduledJobs: DisabledScheduledPluginJob[] = [],
): boolean {
  return disabledScheduledJobs.some((disabled) =>
    disabled.pluginKey === job.pluginKey && disabled.jobKey === job.jobKey
  );
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /** The created run ID. */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
}

/**
 * Diagnostic information about the scheduler.
 */
export interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /** Number of jobs currently executing. */
  activeJobCount: number;
  /** Set of job IDs currently in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * In-flight runs remain tracked and may finish naturally.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * @param jobId - UUID of the job to trigger
   * @param trigger - What triggered this run (default: "manual")
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, or already running
   */
  triggerJob(jobId: string, trigger?: "manual" | "retry"): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
    disabledScheduledJobs = [],
    runtimeLifecycle = runtimeExecutionLifecycle,
  } = options;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /** Set of job IDs currently being executed (for overlap prevention). */
  const activeJobs = new Set<string>();

  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      const queuedPlugins = await db.select({ pluginId: pluginJobRuns.pluginId })
        .from(pluginJobRuns).where(eq(pluginJobRuns.status, "queued"));
      for (const pluginId of new Set(queuedPlugins.map((row) => row.pluginId))) {
        await replayQueuedRuns(pluginId);
      }

      // Query for jobs whose nextRunAt has passed and are active.
      const dueJobs = await db
        .select({
          job: pluginJobs,
          pluginKey: plugins.pluginKey,
        })
        .from(pluginJobs)
        .innerJoin(plugins, eq(pluginJobs.pluginId, plugins.id))
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const dueJob of dueJobs) {
        const job = dueJob.job;
        if (isScheduledPluginJobDisabled(
          { pluginKey: dueJob.pluginKey, jobKey: job.jobKey },
          disabledScheduledJobs,
        )) {
          log.info(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId, pluginKey: dueJob.pluginKey },
            "skipping scheduled plugin job because native owner is active",
          );
          await advanceSchedulePointer(job);
          continue;
        }

        // Concurrency limit
        if (activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeJobs.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Overlap prevention: skip if this job is already running
        if (activeJobs.has(job.id)) {
          log.debug(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
            "skipping job — already running (overlap prevention)",
          );
          continue;
        }

        // Check if the worker is available
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        // Validate cron expression before dispatching
        if (!job.schedule) {
          log.warn(
            { jobId: job.id, jobKey: job.jobKey },
            "skipping job — no schedule defined",
          );
          continue;
        }

        dispatches.push(dispatchJob(job));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  async function dispatchRun(
    job: typeof pluginJobs.$inferSelect,
    run: typeof pluginJobRuns.$inferSelect,
  ): Promise<void> {
    if (activeJobs.has(job.id) || activeJobs.size >= maxConcurrentJobs) return;
    const jobLog = log.child({ jobId: job.id, pluginId: job.pluginId, jobKey: job.jobKey, runId: run.id });
    activeJobs.add(job.id);
    try {
      const result = await executeQueuedPluginJob({
        job, run, jobStore, workerManager, jobTimeoutMs, runtimeLifecycle,
      });
      if (result.kind === "settled") {
        jobLog[result.status === "succeeded" ? "info" : "error"](
          { durationMs: result.durationMs, ...(result.error ? { err: result.error } : {}) },
          `job ${result.status}`,
        );
      } else if (result.kind === "completion_uncertain") {
        jobLog.warn("job completion is uncertain; automatic replay is blocked");
      }
    } catch (err) {
      jobLog.error({ err: err instanceof Error ? err.message : String(err) }, "job dispatch or finalization failed");
      throw err;
    } finally {
      activeJobs.delete(job.id);
    }
  }

  async function replayQueuedRuns(pluginId: string): Promise<void> {
    const queued = await jobStore.listQueuedRunsByPlugin(pluginId, maxConcurrentJobs);
    for (const run of queued) {
      if (activeJobs.size >= maxConcurrentJobs) break;
      const job = await jobStore.getJobByIdForPlugin(pluginId, run.jobId);
      if (!job || job.status !== "active") continue;
      await dispatchRun(job, run);
    }
  }

  async function dispatchJob(job: typeof pluginJobs.$inferSelect): Promise<void> {
    const admission = await jobStore.createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: job.pluginId });
    if (admission.kind === "available") await dispatchRun(job, admission.run);
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
  ): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    // Overlap prevention
    if (activeJobs.has(jobId)) {
      throw new Error(
        `Job "${job.jobKey}" is already running — cannot trigger while in progress`,
      );
    }

    // Also check DB for running runs (defensive — covers multi-instance)
    const existingRuns = await db
      .select()
      .from(pluginJobRuns)
      .where(
        and(
          eq(pluginJobRuns.jobId, jobId),
          eq(pluginJobRuns.status, "running"),
        ),
      );

    if (existingRuns.length > 0) {
      throw new Error(
        `Job "${job.jobKey}" already has a running execution — cannot trigger while in progress`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    // Create the run and dispatch (non-blocking)
    const run = await jobStore.createRun({
      jobId,
      pluginId: job.pluginId,
      trigger,
    });

    // Dispatch in background — don't block the caller
    void dispatchRun(job, run).catch(() => {});

    return { runId: run.id, jobId };
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the `lastRunAt` and `nextRunAt` timestamps on a job after a run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const now = new Date();
    let nextRunAt: Date | null = null;

    if (job.schedule) {
      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, schedule: job.schedule, error: validationError },
          "invalid cron schedule — cannot compute next run",
        );
      } else {
        const cron = parseCron(job.schedule);
        nextRunAt = nextCronTick(cron, now);
      }
    }

    await jobStore.updateRunTimestamps(job.id, now, nextRunAt);
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // An existing due time is the identity of a scheduled slot.
      if (job.nextRunAt) {
        continue;
      }

      // Skip jobs without a schedule
      if (!job.schedule) {
        continue;
      }

      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
          "skipping job with invalid cron schedule",
        );
        continue;
      }

      const cron = parseCron(job.schedule);
      const nextRunAt = nextCronTick(cron, new Date());

      if (nextRunAt) {
        await db.update(pluginJobs).set({ nextRunAt, updatedAt: new Date() }).where(and(
          eq(pluginJobs.id, job.id), isNull(pluginJobs.nextRunAt), eq(pluginJobs.schedule, job.schedule),
        ));
        log.debug(
          { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
          "computed nextRunAt for job",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await replayQueuedRuns(pluginId);
    await ensureNextRunTimestamps(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeJobs.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeJobs.size,
      activeJobIds: [...activeJobs],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    triggerJob,
    tick,
    diagnostics,
  };
}
