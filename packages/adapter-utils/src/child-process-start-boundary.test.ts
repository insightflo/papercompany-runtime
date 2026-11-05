import { describe, expect, it, vi } from "vitest";
import {
  ChildProcessStartRejectedError,
  runChildProcess,
  isChildProcessStartRejectedError,
  startChildProcessAtBoundary,
  withChildProcessStartBoundary,
  type ChildProcessStartScope,
} from "@paperclipai/adapter-utils/server-utils";
import { startChildProcessAtBoundary as startFromSourceModule } from "./child-process-start-boundary.js";

function scope(label: string, allowed = true): ChildProcessStartScope {
  let started = false;
  return {
    identity: {
      requestId: label,
      executionId: `${label}-execution`,
      attemptId: `${label}-attempt`,
      executionGeneration: 1,
    },
    hasExternalStart: () => started,
    start<T>(start: () => T) {
      if (!allowed) {
        return {
          kind: "deferred_before_start" as const,
          deferred: {
            kind: "deferred_before_start" as const,
            version: 1,
            reasonCode: "runtime_shutting_down",
            externalStarted: false as const,
            requestId: label,
            executionId: `${label}-execution`,
            attemptId: `${label}-attempt`,
            executionGeneration: 1,
          },
        };
      }
      if (started) {
        return {
          kind: "additional_start_blocked" as const,
          reasonCode: "runtime_shutting_down",
          externalStarted: true as const,
        };
      }
      const value = start();
      started = true;
      return { kind: "started" as const, value, externalStarted: true as const };
    },
  };
}

describe("child process start boundary context", () => {
  it("keeps the legacy direct start when no execution scope is active", () => {
    const start = vi.fn(() => "started");
    expect(startChildProcessAtBoundary(start)).toBe("started");
    expect(start).toHaveBeenCalledOnce();
  });

  it("initiates an allowed start synchronously through the active scope", () => {
    const order: string[] = [];
    const active = scope("allowed");
    const result = withChildProcessStartBoundary(active, () => {
      order.push("before");
      const value = startChildProcessAtBoundary(() => {
        order.push("start");
        return 42;
      });
      order.push("after");
      return value;
    });
    expect(result).toBe(42);
    expect(order).toEqual(["before", "start", "after"]);
    expect(active.hasExternalStart()).toBe(true);
  });

  it("throws a structured rejection without invoking the external start", () => {
    const start = vi.fn(() => "must-not-run");
    let caught: unknown;
    try {
      withChildProcessStartBoundary(scope("blocked", false), () => startChildProcessAtBoundary(start));
    } catch (error) {
      caught = error;
    }
    expect(start).not.toHaveBeenCalled();
    expect(isChildProcessStartRejectedError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(ChildProcessStartRejectedError);
    if (!isChildProcessStartRejectedError(caught)) throw new Error("expected structured rejection");
    expect(caught.decision).toMatchObject({
      kind: "deferred_before_start",
      deferred: { externalStarted: false, requestId: "blocked" },
    });
  });

  it("isolates overlapping async executions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withChildProcessStartBoundary(scope("first", false), async () => {
      await gate;
      try { return startChildProcessAtBoundary(() => "wrong"); }
      catch (error) {
        if (!isChildProcessStartRejectedError(error) || error.decision.kind !== "deferred_before_start") throw error;
        return error.decision.deferred.requestId;
      }
    });
    const second = withChildProcessStartBoundary(scope("second"), async () => {
      await gate;
      return startChildProcessAtBoundary(() => "second-started");
    });
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second-started");
  });

  it("distinguishes a blocked retry after an earlier external start", () => {
    const active = scope("retry");
    withChildProcessStartBoundary(active, () => {
      expect(startChildProcessAtBoundary(() => "initial")).toBe("initial");
      let caught: unknown;
      try { startChildProcessAtBoundary(() => "duplicate"); }
      catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChildProcessStartRejectedError);
      if (!isChildProcessStartRejectedError(caught)) throw new Error("expected blocked retry");
      expect(caught.decision).toEqual({
        kind: "additional_start_blocked",
        reasonCode: "runtime_shutting_down",
        externalStarted: true,
      });
    });
  });

  it("gates the real process start after asynchronous command resolution", async () => {
    const active = scope("real-blocked", false);
    const onSpawn = vi.fn(async () => {});
    await expect(withChildProcessStartBoundary(active, () => runChildProcess(
      "boundary-blocked", process.execPath, ["-e", "process.exit(0)"],
      { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn },
    ))).rejects.toBeInstanceOf(ChildProcessStartRejectedError);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(active.hasExternalStart()).toBe(false);
  });

  it("preserves the started process result when a later start is blocked", async () => {
    const active = scope("real-retry");
    const run = (id: string) => runChildProcess(id, process.execPath, ["-e", "process.stdout.write('done')"],
      { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {} });
    await withChildProcessStartBoundary(active, async () => {
      const first = await run("boundary-first");
      expect(first.stdout).toBe("done");
      expect(active.hasExternalStart()).toBe(true);
      await expect(run("boundary-retry")).rejects.toMatchObject({ decision: { kind: "additional_start_blocked" } });
    });
  });

  it("shares one storage instance through the package server-utils export", () => {
    const result = withChildProcessStartBoundary(scope("shared"), () =>
      startFromSourceModule(() => "same-instance"));
    expect(result).toBe("same-instance");
  });
});
