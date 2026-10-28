import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeExecutionLifecycle,
  deferredBeforeStartSchema,
} from "../services/runtime-execution-lifecycle.js";

const identity = {
  requestId: "request-1",
  executionId: "run-1",
  attemptId: "attempt-1",
  executionGeneration: 2,
};

describe("runtime execution lifecycle", () => {
  it("starts normal work synchronously and records the external start", () => {
    const lifecycle = createRuntimeExecutionLifecycle();
    const scope = lifecycle.createScope(identity);
    const start = vi.fn(() => "result");

    expect(scope.start(start)).toEqual({
      kind: "started",
      value: "result",
      externalStarted: true,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(scope.hasExternalStart()).toBe(true);
  });

  it("makes shutdown first-wins and returns a versioned deferred value", () => {
    const startedAt = new Date("2026-10-28T10:00:00.000Z");
    const lifecycle = createRuntimeExecutionLifecycle(() => startedAt);
    const first = lifecycle.beginShutdown("SIGTERM");
    const second = lifecycle.beginShutdown("SIGINT");
    const start = vi.fn(() => "must-not-run");
    const decision = lifecycle.createScope(identity).start(start);

    expect(first).toEqual({ changed: true, state: { signal: "SIGTERM", startedAt } });
    expect(second).toEqual({ changed: false, state: first.state });
    expect(lifecycle.shutdownState()).toEqual(first.state);
    expect(decision).toEqual({
      kind: "deferred_before_start",
      deferred: {
        kind: "deferred_before_start",
        version: 1,
        reasonCode: "runtime_shutting_down",
        externalStarted: false,
        ...identity,
      },
    });
    expect(start).not.toHaveBeenCalled();
    if (decision.kind !== "deferred_before_start") throw new Error("expected deferred decision");
    expect(deferredBeforeStartSchema.safeParse(decision.deferred).success).toBe(true);
    expect(deferredBeforeStartSchema.safeParse({ ...decision.deferred, version: 2 }).success).toBe(false);
  });

  it("orders the start/shutdown race at the synchronous boundary", () => {
    const startWins = createRuntimeExecutionLifecycle();
    const started = startWins.createScope(identity).start(() => "started");
    startWins.beginShutdown("SIGTERM");

    const shutdownWins = createRuntimeExecutionLifecycle();
    shutdownWins.beginShutdown("SIGTERM");
    const blocked = shutdownWins.createScope(identity).start(() => "unreachable");

    expect(started.kind).toBe("started");
    expect(blocked.kind).toBe("deferred_before_start");
  });

  it("preserves an in-flight result while blocking a shutdown-time retry", async () => {
    const lifecycle = createRuntimeExecutionLifecycle();
    const scope = lifecycle.createScope(identity);
    let settle!: (value: string) => void;
    const inFlight = new Promise<string>((resolve) => { settle = resolve; });
    const started = scope.start(() => inFlight);

    lifecycle.beginShutdown("SIGTERM");
    const retry = vi.fn(() => Promise.resolve("duplicate"));
    expect(scope.start(retry)).toEqual({
      kind: "additional_start_blocked",
      reasonCode: "runtime_shutting_down",
      externalStarted: true,
    });
    expect(retry).not.toHaveBeenCalled();

    settle("kept-result");
    if (started.kind !== "started") throw new Error("expected started decision");
    await expect(started.value).resolves.toBe("kept-result");
  });

  it("does not claim an external start when initiation throws synchronously", () => {
    const lifecycle = createRuntimeExecutionLifecycle();
    const scope = lifecycle.createScope(identity);

    expect(() => scope.start(() => { throw new Error("spawn failed"); })).toThrow("spawn failed");
    expect(scope.hasExternalStart()).toBe(false);
    lifecycle.beginShutdown("SIGTERM");
    expect(scope.start(() => "unreachable").kind).toBe("deferred_before_start");
  });
});
