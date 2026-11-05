import { describe, expect, it, vi } from "vitest";
import { createAppRuntimeShutdownController, createRuntimeShutdownFlight, createViteDevServerShutdownOwner, createWorkflowToolExecutionTracker } from "../services/runtime-shutdown-controller.js";

describe("runtime shutdown controller", () => {
  it("fences synchronously and shares one failed flight across both signals", async () => {
    const failure = new Error("heartbeat outcome unresolved");
    const events: string[] = [];
    const dispose = vi.fn();
    const drain = vi.fn(async () => {
      events.push("drain");
      throw failure;
    });
    const handleSignal = createRuntimeShutdownFlight({
      beginShutdown: (signal) => events.push(`fence:${signal}`),
      stopIndexStarts: () => events.push("stop:index"),
      stopAppStarts: () => events.push("stop:app"),
      run: vi.fn(async () => {
        await drain();
        await dispose();
      }),
    });

    const first = handleSignal("SIGTERM");
    const second = handleSignal("SIGINT");
    expect(second).toBe(first);
    expect(events).toEqual(["fence:SIGTERM", "stop:index", "stop:app", "drain"]);
    await expect(first).rejects.toBe(failure);
    expect(drain).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("joins startup and producers before retained results and rechecks finalization", async () => {
    const events: string[] = [];
    const controller = createAppRuntimeShutdownController({
      stopStarts: () => events.push("stop"),
      drainStartup: async () => { events.push("startup"); },
      drainProducers: async () => { events.push("producers"); },
      shutdownPlugins: async () => { events.push("retained-results"); },
      drainExecutions: async () => { events.push("executions"); },
      drainHeartbeats: async () => { events.push("heartbeats"); },
      disposeResources: async () => { events.push("dispose"); },
    });

    controller.stopStarts();
    expect(events).toEqual(["stop"]);
    await controller.drain();
    await controller.drain();
    expect(events).toEqual([
      "stop", "startup", "producers", "retained-results", "executions", "heartbeats",
      "executions", "heartbeats",
    ]);
    await controller.dispose();
    await controller.dispose();
    expect(events.slice(-3)).toEqual(["executions", "heartbeats", "dispose"]);
    expect(events.filter((event) => event === "dispose")).toHaveLength(1);
  });

  it("does not dispose resources when a producer drain fails", async () => {
    const failure = new Error("producer drain unresolved");
    const dispose = vi.fn();
    const controller = createAppRuntimeShutdownController({
      stopStarts: vi.fn(),
      drainStartup: vi.fn().mockResolvedValue(undefined),
      drainProducers: vi.fn().mockRejectedValue(failure),
      shutdownPlugins: vi.fn().mockResolvedValue(undefined),
      drainExecutions: vi.fn().mockResolvedValue(undefined),
      drainHeartbeats: vi.fn().mockResolvedValue(undefined),
      disposeResources: dispose,
    });

    await expect(controller.dispose()).rejects.toBe(failure);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("joins heartbeat work after execution drain failure and keeps resources open", async () => {
    const failure = new Error("workflow finalization unresolved");
    const events: string[] = [];
    const dispose = vi.fn();
    const controller = createAppRuntimeShutdownController({
      stopStarts: () => events.push("stop"),
      drainStartup: async () => { events.push("startup"); },
      drainProducers: async () => { events.push("producers"); },
      shutdownPlugins: async () => { events.push("retained-results"); },
      drainExecutions: async () => { events.push("executions"); throw failure; },
      drainHeartbeats: async () => { events.push("heartbeats"); },
      disposeResources: dispose,
    });

    await expect(controller.dispose()).rejects.toBe(failure);
    expect(events).toEqual([
      "stop", "startup", "producers", "retained-results", "executions", "heartbeats",
    ]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps a failed finalization visible after its active execution promise settles", async () => {
    const failure = new Error("completion transaction failed");
    let rejectExecution!: (error: Error) => void;
    const tracker = createWorkflowToolExecutionTracker();
    const tracked = tracker.track(new Promise<never>((_resolve, reject) => { rejectExecution = reject; }));

    rejectExecution(failure);
    await expect(tracked).rejects.toBe(failure);
    await expect(tracker.drain()).rejects.toThrow("did not finalize cleanly");
  });

  it("closes Vite acquired during startup after shutdown drains admitted work", async () => {
    const events: string[] = [];
    const vite = createViteDevServerShutdownOwner();
    const controller = createAppRuntimeShutdownController({
      stopStarts: () => events.push("stop"),
      drainStartup: async () => {
        events.push("startup");
        vite.attach({ close: async () => { events.push("vite-close"); } });
      },
      drainProducers: async () => { events.push("producers"); },
      shutdownPlugins: async () => { events.push("plugins"); },
      drainExecutions: async () => { events.push("executions"); },
      drainHeartbeats: async () => { events.push("heartbeats"); },
      disposeResources: () => vite.close(),
    });

    controller.stopStarts();
    await controller.dispose();
    expect(events).toEqual(["stop", "startup", "producers", "plugins", "executions", "heartbeats", "vite-close"]);
  });
});
