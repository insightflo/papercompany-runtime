import { pluginJobRuns, pluginJobs, plugins, type Db } from "@paperclipai/db";
import { and, asc, desc, eq, isNotNull, isNull, not, or } from "drizzle-orm";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { ObservedJob } from "./plugin-job-rpc.js";
import { nextCronTick, parseCron, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";
import {
  runtimeExecutionLifecycle,
  type DeferredBeforeStart,
  type RuntimeExecutionLifecycle,
} from "./runtime-execution-lifecycle.js";

type Job = typeof pluginJobs.$inferSelect;
type Run = typeof pluginJobRuns.$inferSelect;

/** Filter native-owned schedules before limiting, so they cannot starve manual work. */
export async function listEligibleQueuedPluginRuns(
  db: Db, pluginId: string, limit: number, disabled: { pluginKey: string; jobKey: string }[],
): Promise<Run[]> {
  const disabledMatches = disabled.map(({ pluginKey, jobKey }) =>
    and(eq(plugins.pluginKey, pluginKey), eq(pluginJobs.jobKey, jobKey)));
  const rows = await db.select({ run: pluginJobRuns }).from(pluginJobRuns)
    .innerJoin(pluginJobs, and(eq(pluginJobRuns.jobId, pluginJobs.id), eq(pluginJobRuns.pluginId, pluginJobs.pluginId)))
    .innerJoin(plugins, eq(pluginJobRuns.pluginId, plugins.id))
    .where(and(
      eq(pluginJobRuns.pluginId, pluginId), eq(pluginJobs.status, "active"), eq(pluginJobRuns.status, "queued"),
      isNull(pluginJobRuns.startedAt), isNull(pluginJobRuns.finishedAt), isNull(pluginJobRuns.claimToken),
      isNull(pluginJobRuns.completionUncertainty),
      or(eq(pluginJobRuns.trigger, "manual"), eq(pluginJobRuns.trigger, "retry"), and(
        eq(pluginJobRuns.trigger, "schedule"), isNotNull(pluginJobRuns.scheduledAt), isNotNull(pluginJobRuns.scheduledCron),
        disabledMatches.length ? not(or(...disabledMatches)!) : undefined,
      )),
    )).orderBy(asc(pluginJobRuns.createdAt), asc(pluginJobRuns.id)).limit(limit);
  return rows.map(({ run }) => run);
}

/** Seed missing schedule slots while respecting registration cancellation. */
export async function ensurePluginJobSchedules(
  db: Db, store: PluginJobStore, pluginId: string, admitted: () => boolean,
) {
  const jobs = await store.listJobs(pluginId, "active");
  for (const job of jobs) {
    if (!admitted()) return;
    if (job.nextRunAt || !job.schedule) continue;
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(pluginJobs)
        .where(and(eq(pluginJobs.id, job.id), eq(pluginJobs.pluginId, pluginId))).for("update").limit(1);
      if (!admitted() || !current || current.status !== "active" || current.nextRunAt ||
          !current.schedule || current.schedule !== job.schedule) return;
      const validationError = validateCron(current.schedule);
      if (validationError) {
        logger.warn({ jobId: current.id, jobKey: current.jobKey, schedule: current.schedule, error: validationError },
          "skipping job with invalid cron schedule");
        return;
      }
      const [latest] = await tx.select({ scheduledAt: pluginJobRuns.scheduledAt }).from(pluginJobRuns)
        .where(and(eq(pluginJobRuns.jobId, current.id), eq(pluginJobRuns.trigger, "schedule"), isNotNull(pluginJobRuns.scheduledAt)))
        .orderBy(desc(pluginJobRuns.scheduledAt)).limit(1);
      if (!admitted()) return;
      const now = new Date();
      const after = new Date(Math.max(now.getTime(), latest?.scheduledAt?.getTime() ?? now.getTime()));
      const nextRunAt = nextCronTick(parseCron(current.schedule), after);
      if (!nextRunAt) return;
      await tx.update(pluginJobs).set({ nextRunAt, updatedAt: new Date() }).where(and(
        eq(pluginJobs.id, current.id), isNull(pluginJobs.nextRunAt), eq(pluginJobs.schedule, current.schedule),
        eq(pluginJobs.status, "active"),
      ));
    });
  }
}

/** Skip an unclaimed native-owned slot using the existing scheduler policy. */
export async function advanceDisabledPluginSchedule(store: PluginJobStore, job: Job) {
  const now = new Date();
  let nextRunAt: Date | null = null;
  if (job.schedule) {
    const error = validateCron(job.schedule);
    if (error) logger.warn({ jobId: job.id, schedule: job.schedule, error }, "invalid cron schedule — cannot compute next run");
    else nextRunAt = nextCronTick(parseCron(job.schedule), now);
  }
  await store.updateRunTimestamps(job.id, now, nextRunAt);
}

const PERSISTENCE_RETRY_MS = 1_000;
const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, PERSISTENCE_RETRY_MS));

async function finishObservedJob(
  observed: Extract<ObservedJob, { kind: "sent_or_unknown" }>,
  store: PluginJobStore,
  run: Run & { startedAt: Date; claimToken: string },
): Promise<PluginJobReplayResult> {
  let uncertaintyWrite: Promise<void> | undefined;
  const recordUncertainty = () => uncertaintyWrite ??= (async () => {
    while (observed.state() !== "settled") {
      try {
        if (await store.markCompletionUncertain(run.id, run.claimToken)) return;
      } catch (err) {
        logger.warn({ err, runId: run.id }, "plugin job uncertainty persistence failed; retrying");
      }
      await retryDelay();
    }
  })();

  type FirstAttempt = { kind: "result"; result: PluginJobReplayResult } | { kind: "error"; error: unknown };
  let resolveFirst!: (value: FirstAttempt) => void;
  const firstAttempt = new Promise<FirstAttempt>((resolve) => { resolveFirst = resolve; });
  void (async () => {
    const actual = await observed.actual;
    if (actual.kind === "unknown") {
      await recordUncertainty();
      observed.release();
      resolveFirst({ kind: "result", result: { kind: "completion_uncertain" } });
      return;
    }
    const outcome = {
      status: actual.kind,
      ...(actual.kind === "failed" ? { error: actual.error } : {}),
      durationMs: Date.now() - run.startedAt.getTime(),
    } as const;
    if (uncertaintyWrite) await uncertaintyWrite;
    let first = true;
    for (;;) {
      try {
        const result = await store.finalizeClaimedRun(run.id, run.claimToken, outcome);
        if (result === "rejected") throw new Error("plugin_job_finalization_claim_lost");
        observed.release();
        if (first) resolveFirst({ kind: "result", result: { kind: "settled", ...outcome } });
        return;
      } catch (error) {
        if (first) resolveFirst({ kind: "error", error });
        first = false;
        logger.warn({ err: error, runId: run.id }, "plugin job finalization failed; retrying the same outcome");
        await retryDelay();
      }
    }
  })();

  const initial = await observed.initial;
  if (initial !== "settled" && observed.state() !== "settled") {
    await recordUncertainty();
    if (observed.state() !== "settled") return { kind: "completion_uncertain" };
  }
  const first = await firstAttempt;
  if (first.kind === "error") throw first.error;
  return first.result;
}

export type PluginJobReplayResult =
  | { kind: "not_claimed" }
  | { kind: "unavailable_before_start" }
  | { kind: "deferred_before_start"; deferred: DeferredBeforeStart }
  | { kind: "completion_uncertain" }
  | { kind: "settled"; status: "succeeded" | "failed"; durationMs: number; error?: string };

export async function executeQueuedPluginJob(input: {
  job: Job;
  run: Run;
  jobStore: PluginJobStore;
  workerManager: PluginWorkerManager;
  jobTimeoutMs: number;
  runtimeLifecycle?: RuntimeExecutionLifecycle;
  admitted?: () => boolean;
}): Promise<PluginJobReplayResult> {
  const claimed = await input.jobStore.claimQueuedRun(input.run.id);
  if (!claimed?.startedAt || !claimed.claimToken) return { kind: "not_claimed" };
  const claimToken = claimed.claimToken;

  const release = async () => {
    for (;;) {
      try {
        if (await input.jobStore.releaseUnstartedClaim(claimed.id, claimToken)) return;
        // The write may have committed even if its acknowledgement was lost.
        const current = await input.jobStore.getRunById(claimed.id);
        if (current?.status === "queued" && !current.startedAt && !current.finishedAt &&
            !current.claimToken && !current.completionUncertainty) return;
        logger.warn({ runId: claimed.id }, "unstarted plugin job claim was not released; retrying");
      } catch (error) {
        logger.warn({ err: error, runId: claimed.id }, "unstarted plugin job release failed; retrying");
      }
      await retryDelay();
    }
  };
  const uncertain = async (): Promise<PluginJobReplayResult> => {
    if (!await input.jobStore.markCompletionUncertain(claimed.id, claimToken)) {
      throw new Error("plugin_job_uncertain_claim_lost");
    }
    return { kind: "completion_uncertain" };
  };
  if (!input.workerManager.isRunning(input.job.pluginId)) {
    await release();
    return { kind: "unavailable_before_start" };
  }
  // A manager without the observed RPC contract cannot safely send a real job.
  // The old call-only branch below exists for incomplete in-process test doubles.
  if (typeof input.workerManager.observeJob !== "function" && typeof input.workerManager.getWorker === "function") {
    await release();
    return { kind: "unavailable_before_start" };
  }

  const lifecycle = input.runtimeLifecycle ?? runtimeExecutionLifecycle;
  const scope = lifecycle.createScope({
    requestId: claimed.id,
    executionId: input.job.id,
    attemptId: claimed.claimToken,
    executionGeneration: 0,
  });
  const params = { job: {
      jobKey: input.job.jobKey,
      runId: claimed.id,
      trigger: claimed.trigger,
      scheduledAt: (claimed.trigger === "schedule" ? claimed.scheduledAt! : claimed.startedAt!).toISOString(),
    } };
  // Legacy test doubles implement only call(); real managers expose observeJob.
  const start = () => typeof input.workerManager.observeJob === "function"
    ? { kind: "observed" as const, value: input.workerManager.observeJob(input.job.pluginId, params, input.jobTimeoutMs) }
    : { kind: "legacy" as const, value: input.workerManager.call(input.job.pluginId, "runJob", params, input.jobTimeoutMs) };
  let decision: ReturnType<typeof scope.start<ReturnType<typeof start>>>;
  if (input.admitted && !input.admitted()) {
    await release();
    return { kind: "unavailable_before_start" };
  }
  try {
    decision = scope.start(start);
  } catch {
    return uncertain();
  }
  if (decision.kind === "deferred_before_start") {
    await release();
    return { kind: "deferred_before_start", deferred: decision.deferred };
  }
  if (decision.kind === "additional_start_blocked") {
    return uncertain();
  }

  if (decision.value.kind === "observed") {
    const observed = decision.value.value;
    if (observed.kind === "definitely_unsent") {
      await release();
      return { kind: "unavailable_before_start" };
    }
    return finishObservedJob(observed, input.jobStore, { ...claimed, startedAt: claimed.startedAt, claimToken });
  }

  let outcome: { status: "succeeded" | "failed"; error?: string };
  try {
    await decision.value.value;
    outcome = { status: "succeeded" };
  } catch (error) {
    if (!(error instanceof JsonRpcCallError) || error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT ||
        error.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE) {
      return uncertain();
    }
    outcome = { status: "failed", error: error.message };
  }
  const durationMs = Date.now() - claimed.startedAt.getTime();
  const finalized = await input.jobStore.finalizeClaimedRun(claimed.id, claimToken, { ...outcome, durationMs });
  if (finalized === "rejected") throw new Error("plugin_job_finalization_claim_lost");
  return { kind: "settled", ...outcome, durationMs };
}
