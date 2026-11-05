import { startChildProcessAtBoundary } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatAdapterScope, isHeartbeatUnstartedDeferral, runWithinHeartbeatAdapterScope } from "../services/heartbeat-adapter-scope.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const run = { runId: "run-a", wakeupRequestId: "wake-a", executorOwnerLeaseToken: "owner-a",
  executionEpoch: 3, workflowExecutionGeneration: 2 };

describe("heartbeat adapter scope", () => {
  it("recognizes only the matching unstarted run after shutdown", async () => {
    const lifecycle = createRuntimeExecutionLifecycle(), scope = createHeartbeatAdapterScope(lifecycle, run), start = vi.fn();
    lifecycle.beginShutdown("SIGTERM");
    let caught: unknown;
    try { await runWithinHeartbeatAdapterScope(scope, async () => { await Promise.resolve(); startChildProcessAtBoundary(start); }); }
    catch (error) { caught = error; }
    expect(start).not.toHaveBeenCalled();
    expect(isHeartbeatUnstartedDeferral(caught, scope, run, lifecycle)).toBe(true);
    expect(isHeartbeatUnstartedDeferral(caught, scope, { ...run, runId: "other" }, lifecycle)).toBe(false);
    expect(isHeartbeatUnstartedDeferral(new Error("deferred"), scope, run, lifecycle)).toBe(false);
  });

  it("does not call a blocked retry an unstarted run after an actual start", () => {
    const lifecycle = createRuntimeExecutionLifecycle(), scope = createHeartbeatAdapterScope(lifecycle, run), start = vi.fn();
    runWithinHeartbeatAdapterScope(scope, () => startChildProcessAtBoundary(start));
    lifecycle.beginShutdown("SIGTERM");
    let caught: unknown;
    try { runWithinHeartbeatAdapterScope(scope, () => startChildProcessAtBoundary(start)); } catch (error) { caught = error; }
    expect(start).toHaveBeenCalledTimes(1);
    expect(isHeartbeatUnstartedDeferral(caught, scope, run, lifecycle)).toBe(false);
  });
});
