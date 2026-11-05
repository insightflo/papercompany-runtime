import type { pluginJobRuns, pluginJobs } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  runtimeExecutionLifecycle,
  type DeferredBeforeStart,
  type RuntimeExecutionLifecycle,
} from "./runtime-execution-lifecycle.js";

type Job = typeof pluginJobs.$inferSelect;
type Run = typeof pluginJobRuns.$inferSelect;

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

  const lifecycle = input.runtimeLifecycle ?? runtimeExecutionLifecycle;
  const scope = lifecycle.createScope({
    requestId: claimed.id,
    executionId: input.job.id,
    attemptId: claimed.claimToken,
    executionGeneration: 0,
  });
  const start = () => input.workerManager.call(
    input.job.pluginId,
    "runJob",
    { job: {
      jobKey: input.job.jobKey,
      runId: claimed.id,
      trigger: claimed.trigger,
      scheduledAt: (claimed.trigger === "schedule" ? claimed.scheduledAt! : claimed.startedAt!).toISOString(),
    } },
    input.jobTimeoutMs,
  );
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

  let outcome: { status: "succeeded" | "failed"; error?: string };
  try {
    await decision.value;
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
