import { isChildProcessStartRejectedError, withChildProcessStartBoundary } from "@paperclipai/adapter-utils/server-utils";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeExecutionLifecycle, RuntimeExecutionScope } from "./runtime-execution-lifecycle.js";

export type HeartbeatStartIdentity = {
  runId: string;
  wakeupRequestId: string | null;
  executorOwnerLeaseToken: string | null;
  executionEpoch: number | null;
  workflowExecutionGeneration: number | null;
};

export function createHeartbeatAdapterScope(lifecycle: RuntimeExecutionLifecycle, run: HeartbeatStartIdentity): RuntimeExecutionScope {
  return lifecycle.createScope({ requestId: run.wakeupRequestId ?? run.runId, executionId: run.runId,
    attemptId: run.executorOwnerLeaseToken ?? run.runId,
    executionGeneration: run.executionEpoch ?? run.workflowExecutionGeneration ?? 0 });
}

export function runWithinHeartbeatAdapterScope<T>(scope: RuntimeExecutionScope, execute: () => T): T {
  return withChildProcessStartBoundary(scope, execute);
}

/** A deferral is valid only for this exact run, before any external attempt. */
export function isHeartbeatUnstartedDeferral(error: unknown, scope: RuntimeExecutionScope, run: HeartbeatStartIdentity,
  lifecycle: RuntimeExecutionLifecycle): boolean {
  const identity = { requestId: run.wakeupRequestId ?? run.runId, executionId: run.runId,
    attemptId: run.executorOwnerLeaseToken ?? run.runId,
    executionGeneration: run.executionEpoch ?? run.workflowExecutionGeneration ?? 0 };
  if (!lifecycle.shutdownState() || scope.hasExternalStart() || !isDeepStrictEqual(scope.identity, identity)
    || !isChildProcessStartRejectedError(error) || error.decision.kind !== "deferred_before_start") return false;
  const { deferred } = error.decision;
  return deferred.kind === "deferred_before_start" && deferred.version === 1
    && deferred.reasonCode === "runtime_shutting_down" && deferred.externalStarted === false
    && isDeepStrictEqual(identity, { requestId: deferred.requestId, executionId: deferred.executionId,
      attemptId: deferred.attemptId, executionGeneration: deferred.executionGeneration });
}
