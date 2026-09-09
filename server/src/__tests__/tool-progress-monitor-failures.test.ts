import { afterEach, describe, expect, it, vi } from "vitest";
import { withToolProgress } from "../services/tools/progress-monitor.js";
import type { ToolProgressHeartbeat, ToolProgressStore } from "../services/tools/progress-store.js";
import { policy } from "./helpers/tool-progress.js";

const heartbeat: ToolProgressHeartbeat = {
  id: "00000000-0000-4000-8000-000000000001", companyId: "company", toolId: "tool", requestId: "test",
  adapterType: "builtin", policy: { ...policy, maxDurationMs: 3000 }, workflowRunId: null, stepId: null,
  stepRunId: null, executionGeneration: null, retryCount: null, iterationIndex: null,
  startedAt: new Date(), lastProgressAt: new Date(), sequence: 0, stageIndex: -1, current: 0,
  total: null, state: "active", finishedAt: null, reason: null,
};
function mocks() {
  const store = {
    start: vi.fn(async () => heartbeat), accept: vi.fn(), acceptLocal: vi.fn(),
    check: vi.fn(async () => heartbeat),
    finish: vi.fn<ToolProgressStore["finish"]>(async (_company, _id, outcome) => ({ ...heartbeat, state: outcome })),
  } satisfies ToolProgressStore;
  return store;
}
afterEach(() => { vi.useRealTimers(); });

describe("unit-injected monitor failures (not DB integration)", () => {
  it("check/read rejection aborts operation and clears timers", async () => {
    vi.useFakeTimers(); const store = mocks();
    store.check.mockRejectedValue(new Error("read rejected"));
    let signal: AbortSignal | undefined;
    const observed = withToolProgress({ store, heartbeat, succeeded: () => true,
      operation: async (s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener("abort", () => reject(s.reason))); },
    }).then(() => "unexpected-success", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await observed).toMatchObject({ reason: "tool_progress_db_failure" });
    expect(signal?.aborted).toBe(true); expect(store.check).toHaveBeenCalledTimes(1);
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(["failed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finish rejection cannot return success and aborts the signal", async () => {
    vi.useFakeTimers(); const store = mocks(); store.finish.mockRejectedValue(new Error("finish rejected"));
    let signal: AbortSignal | undefined;
    const observed = withToolProgress({ store, heartbeat, succeeded: () => true,
      operation: async (s) => { signal = s; return "validated"; },
    }).then(() => "unexpected-success", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await observed).toMatchObject({ message: "finish rejected" });
    expect(signal?.aborted).toBe(true);
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(["succeeded", "failed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("bounds abort-ignoring operation, late %s cannot finish or leak rejection", async (late) => {
    vi.useFakeTimers(); const store = mocks();
    let resolve!: (value: string) => void; let reject!: (error: Error) => void; let signal: AbortSignal | undefined;
    const operation = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const observed = withToolProgress({ store, heartbeat, succeeded: () => true,
      operation: async (s) => { signal = s; return operation; },
    }).then(() => "unexpected-success", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await observed).toMatchObject({ reason: "tool_progress_max_timeout" });
    expect(signal?.aborted).toBe(true);
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(["failed"]);
    if (late === "resolve") resolve("late validated result"); else reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(10);
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(["failed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds failed terminal persistence even when check and finish never settle", async () => {
    vi.useFakeTimers(); const store = mocks();
    store.check.mockImplementation(() => new Promise(() => {}));
    store.finish.mockImplementation(() => new Promise(() => {}));
    const observed = withToolProgress({ store, heartbeat, succeeded: () => true,
      operation: async () => new Promise(() => {}),
    }).then(() => "unexpected-success", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5501);
    expect(await observed).toMatchObject({ reason: "tool_progress_max_timeout" });
    expect(store.check).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
