import type { pluginJobRuns, pluginJobs } from "@paperclipai/db";
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

  const release = async () => {
    if (!await input.jobStore.releaseUnstartedClaim(claimed.id, claimed.claimToken!)) {
      throw new Error("plugin_job_unstarted_claim_release_lost");
    }
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
      scheduledAt: claimed.createdAt.toISOString(),
    } },
    input.jobTimeoutMs,
  );
  const decision = scope.start(start);
  if (decision.kind === "deferred_before_start") {
    await release();
    return { kind: "deferred_before_start", deferred: decision.deferred };
  }
  if (decision.kind === "additional_start_blocked") {
    throw new Error("runtime_additional_start_blocked");
  }

  try {
    await decision.value;
    const durationMs = Date.now() - claimed.startedAt.getTime();
    await input.jobStore.completeRun(claimed.id, { status: "succeeded", durationMs });
    return { kind: "settled", status: "succeeded", durationMs };
  } catch (error) {
    const durationMs = Date.now() - claimed.startedAt.getTime();
    const message = error instanceof Error ? error.message : String(error);
    await input.jobStore.completeRun(claimed.id, { status: "failed", error: message, durationMs });
    return { kind: "settled", status: "failed", error: message, durationMs };
  }
}
