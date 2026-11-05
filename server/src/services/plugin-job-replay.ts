import type { pluginJobRuns, pluginJobs } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { ObservedJob } from "./plugin-job-rpc.js";
import { logger } from "../middleware/logger.js";
import {
  runtimeExecutionLifecycle,
  type DeferredBeforeStart,
  type RuntimeExecutionLifecycle,
} from "./runtime-execution-lifecycle.js";

type Job = typeof pluginJobs.$inferSelect;
type Run = typeof pluginJobRuns.$inferSelect;

const FINALIZATION_RETRY_MS = 1_000;
const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, FINALIZATION_RETRY_MS));

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
}): Promise<PluginJobReplayResult> {
  const claimed = await input.jobStore.claimQueuedRun(input.run.id);
  if (!claimed?.startedAt || !claimed.claimToken) return { kind: "not_claimed" };
  const claimToken = claimed.claimToken;

  const release = async () => {
    if (!await input.jobStore.releaseUnstartedClaim(claimed.id, claimToken)) {
      throw new Error("plugin_job_unstarted_claim_release_lost");
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
