import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { createHeartbeatRunLog } from "../services/heartbeat-run-log.js";
import { publishLiveEvent } from "../services/live-events.js";
import { serializeRunLogEvent, type RunLogStore } from "../services/run-log-store.js";
import { evaluateRuntimeBroadScanHook } from "../services/runtime-broad-scan-hook.js";

const { progress } = vi.hoisted(() => ({ progress: vi.fn() }));
vi.mock("../adapters/index.js", () => ({ runningProcesses: new Map() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/hermes-chat.js", () => ({
  hermesChatService: vi.fn(() => ({ updateAssistantProgress: progress })),
}));
vi.mock("../services/runtime-broad-scan-hook.js", () => ({ evaluateRuntimeBroadScanHook: vi.fn() }));

type Options = Parameters<typeof createHeartbeatRunLog>[0];
function fixture(overrides: Partial<Options> = {}) {
  const run = { id: "run", companyId: "company", agentId: "agent" } as ReturnType<Options["getRun"]>;
  const handle = { store: "local_file" as const, logRef: "company/agent/run.ndjson" };
  const summary = { bytes: 123, sha256: "actual-file-hash", compressed: false };
  const writes: Record<string, unknown>[] = [];
  const where = vi.fn(async (): Promise<void> => undefined);
  const set = vi.fn((values: Record<string, unknown>) => {
    writes.push(values);
    return { where };
  });
  const db = { update: vi.fn(() => ({ set })) } as unknown as Db;
  const store: RunLogStore = {
    begin: vi.fn(async () => handle),
    append: vi.fn(async () => undefined),
    finalize: vi.fn(async () => summary),
    read: vi.fn(async () => ({ content: "" })),
  };
  let seq = 2; // The caller's run-start event has already consumed sequence 1.
  const events: Array<{ seq: number; value: unknown }> = [];
  const appendEvent = vi.fn(async (value: Parameters<Options["appendEvent"]>[0]) => {
    events.push({ seq: seq++, value });
  });
  const appendBroadScanEvent = vi.fn(async (value: Parameters<Options["appendBroadScanEvent"]>[0]) => {
    events.push({ seq, value });
    seq++;
  });
  const log = createHeartbeatRunLog({
    db, getRun: () => run, adapterType: "opencode_local", context: {},
    config: { runawayLogLimitBytes: 0 }, store,
    getRedactionOptions: async () => ({ enabled: false }),
    appendEvent, appendBroadScanEvent, ...overrides,
  });
  return { log, store, handle, summary, writes, where, events, appendEvent, appendBroadScanEvent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  vi.mocked(evaluateRuntimeBroadScanHook).mockReset().mockResolvedValue({ intercepted: false });
  progress.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  runningProcesses.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("C07 run-log extraction preserves the existing output contract", () => {
  it("begins storage before recording its reference, then loads redaction settings", async () => {
    const order: string[] = [];
    const h = fixture({ getRedactionOptions: async () => {
      order.push("settings");
      return { enabled: false };
    } });
    vi.mocked(h.store.begin).mockImplementation(async input => {
      expect(input).toEqual({ companyId: "company", agentId: "agent", runId: "run" });
      order.push("begin");
      return h.handle;
    });
    h.where.mockImplementation(async () => { order.push("reference"); });
    await h.log.begin();
    expect(order).toEqual(["begin", "reference", "settings"]);
    expect(h.writes[0]).toEqual({ logStore: "local_file", logRef: h.handle.logRef, updatedAt: new Date() });
  });

  it("redacts before storage, caps each excerpt/live tail, and touches activity only at receipt intervals", async () => {
    const h = fixture({ getRedactionOptions: async () => ({
      userNames: ["fixtureuser"], homeDirs: ["/home/fixtureuser"],
    }) });
    await h.log.begin();
    const first = "fixtureuser\n";
    const tail = "x".repeat(MAX_EXCERPT_BYTES + 5);
    await h.log.onLog("stdout", first);
    await h.log.onLog("stderr", "problem\n");
    await h.log.onLog("stdout", tail);
    expect(h.log.stdoutExcerpt).toBe("x".repeat(MAX_EXCERPT_BYTES));
    expect(h.log.stderrExcerpt).toBe("problem\n");
    expect(vi.mocked(h.store.append).mock.calls.map(call => call[1].chunk))
      .toEqual(["f**********\n", "problem\n", tail]);
    const live = vi.mocked(publishLiveEvent).mock.calls;
    expect(live.map(call => call[0].payload?.stream)).toEqual(["stdout", "stderr", "stdout"]);
    expect(live[2][0].payload).toMatchObject({ chunk: "x".repeat(8192), truncated: true });
    expect(h.writes).toHaveLength(2); // Reference plus the first received chunk.
    vi.setSystemTime(34_999);
    await h.log.onLog("stderr", "a");
    expect(h.writes).toHaveLength(2);
    vi.setSystemTime(35_000);
    await h.log.onLog("stderr", "b");
    expect(h.writes[2]).toEqual({ updatedAt: new Date(35_000) });
  });

  it("keeps separate line buffers and audits before forwarding the replacement chunk", async () => {
    const h = fixture();
    await h.log.begin();
    const order: string[] = [];
    h.appendBroadScanEvent.mockImplementation(async value => { order.push("audit:" + value.line); });
    vi.mocked(h.store.append).mockImplementation(async (_handle, event) => { order.push("store:" + event.chunk); });
    await h.log.onLog("stdout", "bloc");
    await h.log.onLog("stderr", "safe\r\n");
    vi.mocked(evaluateRuntimeBroadScanHook).mockResolvedValueOnce({
      intercepted: true, syntheticOutput: "audit\n", rewrittenCommand: "blocked",
    });
    await h.log.onLog("stdout", "ked\nlost\n");
    expect(vi.mocked(evaluateRuntimeBroadScanHook).mock.calls.map(call => call[1].line))
      .toEqual(["safe", "blocked"]);
    expect(order).toEqual(["store:bloc", "store:safe\r\n", "audit:blocked", "store:audit\n"]);
    expect(h.log.stdoutExcerpt).toBe("blocaudit\n");
    expect(h.log.stderrExcerpt).toBe("safe\r\n");
    expect(h.appendBroadScanEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "runtime_hook", stream: "stdout", matchedCommand: "blocked",
    }));
  });

  it.each([1, 2])("caps whole UTF-8 records at equality, retains only the prefix and never kills the child", async capacity => {
    const chunk = "é\n\"\\";
    const record = "{\"ts\":\"1970-01-01T00:00:20.000Z\",\"stream\":\"stdout\",\"chunk\":\"é\\n\\\"\\\\\"}\n";
    const bytes = Buffer.byteLength(record);
    const rejected = "x".repeat(bytes * 2);
    const omitted = "{\"ts\":\"1970-01-01T00:00:20.000Z\",\"stream\":\"stderr\",\"chunk\":\"" + rejected + "\"}\n{\"ts\":\"1970-01-01T00:00:20.000Z\",\"stream\":\"stdout\",\"chunk\":\"\"}\n";
    expect(serializeRunLogEvent({ ts: new Date().toISOString(), stream: "stdout", chunk })).toBe(record);
    const h = fixture({ config: { runawayLogLimitBytes: bytes * capacity } });
    await h.log.begin();
    const child = { kill: vi.fn(() => true), killed: false };
    type Tracked = NonNullable<ReturnType<typeof runningProcesses.get>>;
    runningProcesses.set("run", { child, graceSec: 0 } as unknown as Tracked);
    await h.log.onLog("stdout", chunk);
    await h.log.onLog("stderr", rejected);
    await h.log.onLog("stdout", ""); // Even a shorter record after overflow is omitted.
    expect(h.store.append).toHaveBeenCalledTimes(1);
    expect(h.log.runawayTriggered).toBe(false);
    expect(runningProcesses.has("run")).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(publishLiveEvent).toHaveBeenCalledTimes(3);
    expect(h.log.stderrExcerpt).toBe(rejected);
    await h.log.finalize();
    expect(h.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "log_storage_summary", payload: expect.objectContaining({
        version: 1, storageLimitBytes: bytes * capacity, storedRecords: 1, storedBytes: bytes,
        omittedRecords: 2, omittedBytes: Buffer.byteLength(omitted), writeErrors: 0,
        actualBytes: 123, sha256: "actual-file-hash",
      }),
    }));
  });

  it("shares audit sequencing and caps the trailing synthetic flush through the same boundary", async () => {
    const h = fixture({ config: { runawayLogLimitBytes: 80 } });
    await h.log.begin();
    await h.log.onLog("stdout", "blocked");
    vi.mocked(evaluateRuntimeBroadScanHook).mockResolvedValueOnce({ intercepted: true, syntheticOutput: "audit".repeat(20) });
    await h.log.flushRuntimeGuardLines();
    await h.log.finalizeAfterError();
    await h.log.finalize();
    expect(h.store.append).toHaveBeenCalledTimes(1);
    expect(h.events.map(event => event.seq)).toEqual([2, 3]);
    expect(h.appendBroadScanEvent).toHaveBeenCalledTimes(1);
    expect(h.appendEvent).toHaveBeenCalledTimes(1);
    expect(h.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ storedRecords: 1, omittedRecords: 1, writeErrors: 0 }),
    }));
  });

  it.each([0, 80])("separates failed writes from omissions without consuming budget (limit=%s)", async limit => {
    const h = fixture({ config: { runawayLogLimitBytes: limit } });
    await h.log.begin();
    vi.mocked(h.store.append).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(h.log.onLog("stdout", "failed")).rejects.toThrow("storage unavailable");
    await h.log.onLog("stdout", "stored");
    expect(await h.log.finalizeAfterError()).toBe(h.summary);
    expect(h.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ storageLimitBytes: limit, storedRecords: 1, omittedRecords: 0, omittedBytes: 0, writeErrors: 1 }),
    }));
    expect(h.log.runawayTriggered).toBe(false);
  });

  it.each(["stdout", "stderr"] as const)("flushes a trailing %s audit without replaying onLog", async stream => {
    const h = fixture();
    await h.log.begin();
    await h.log.onLog(stream, "blocked");
    const writes = h.writes.length;
    const liveCount = vi.mocked(publishLiveEvent).mock.calls.length;
    vi.mocked(evaluateRuntimeBroadScanHook).mockResolvedValueOnce({
      intercepted: true, syntheticOutput: "audit".repeat(20),
    });
    vi.mocked(h.store.append).mockRejectedValueOnce(new Error("audit storage unavailable"));
    await h.log.flushRuntimeGuardLines();
    expect(vi.mocked(h.store.append).mock.calls[1][1]).toEqual({
      stream: "stdout", chunk: "audit".repeat(20), ts: new Date().toISOString(),
    });
    expect(h.events).toEqual([{ seq: 2, value: expect.objectContaining({
      phase: "runtime_hook", line: "blocked",
    }) }]);
    expect(h.log.stdoutExcerpt).toBe(stream === "stdout" ? "blocked" : "");
    expect(h.log.stderrExcerpt).toBe(stream === "stderr" ? "blocked" : "");
    expect(h.log.runawayTriggered).toBe(false);
    expect(h.writes).toHaveLength(writes);
    expect(publishLiveEvent).toHaveBeenCalledTimes(liveCount);
    await h.log.flushRuntimeGuardLines();
    expect(h.appendBroadScanEvent).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("drains stdout before stderr and stops at interception, first=%s", async first => {
    const h = fixture();
    await h.log.begin();
    await h.log.onLog("stdout", "out");
    await h.log.onLog("stderr", "err");
    vi.mocked(evaluateRuntimeBroadScanHook).mockResolvedValueOnce({ intercepted: first, syntheticOutput: "audit" })
      .mockResolvedValueOnce({ intercepted: true, syntheticOutput: "audit" });
    await h.log.flushRuntimeGuardLines();
    expect(vi.mocked(evaluateRuntimeBroadScanHook).mock.calls.map(call => call[1].line))
      .toEqual(first ? ["out"] : ["out", "err"]);
    await h.log.flushRuntimeGuardLines();
    expect(evaluateRuntimeBroadScanHook).toHaveBeenCalledTimes(first ? 1 : 2);
  });

  it("retains excerpts but propagates an ordinary append failure before guard/touch/live effects", async () => {
    const h = fixture();
    await h.log.begin();
    const error = new Error("ordinary append unavailable");
    vi.mocked(h.store.append).mockRejectedValueOnce(error);
    await expect(h.log.onLog("stderr", "xx")).rejects.toBe(error);
    expect(h.log.stderrExcerpt).toBe("xx");
    expect(h.log.runawayTriggered).toBe(false);
    expect(h.appendEvent).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(1);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("keeps normal finalize errors observable and retries finalization in the error path", async () => {
    const h = fixture();
    expect(await h.log.finalize()).toBeNull();
    expect(h.store.finalize).not.toHaveBeenCalled();
    await h.log.begin();
    const error = new Error("finalize unavailable");
    vi.mocked(h.store.finalize).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await expect(h.log.finalize()).rejects.toBe(error);
    expect(await h.log.finalizeAfterError()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({ err: error, runId: "run" }, "failed to finalize run log after error");
    expect(await h.log.finalizeAfterError()).toBe(h.summary);
    expect(vi.mocked(h.store.finalize).mock.calls).toEqual([[h.handle], [h.handle], [h.handle]]);
  });

  it("finalizes an opened handle even when persisting its reference fails", async () => {
    const h = fixture();
    h.where.mockRejectedValueOnce(new Error("reference unavailable"));
    await expect(h.log.begin()).rejects.toThrow("reference unavailable");
    expect(await h.log.finalizeAfterError()).toBe(h.summary);
    const unopened = fixture();
    vi.mocked(unopened.store.begin).mockRejectedValueOnce(new Error("begin unavailable"));
    await expect(unopened.log.begin()).rejects.toThrow("begin unavailable");
    expect(await unopened.log.finalizeAfterError()).toBeNull();
    expect(unopened.store.finalize).not.toHaveBeenCalled();
  });

  it("throttles Hermes stdout progress independently and tolerates progress write failure", async () => {
    const h = fixture({ adapterType: "hermes_local", context: {
      paperclipHermesChat: { assistantMessageId: "assistant" },
    } });
    await h.log.begin();
    progress.mockRejectedValueOnce(new Error("chat unavailable"));
    await h.log.onLog("stdout", "    알겠습니다. 구조를 확인하고 영향도를 파악하겠습니다.\n");
    expect(progress).toHaveBeenCalledTimes(1);
    vi.setSystemTime(21_000);
    await h.log.onLog("stdout", "    먼저 workflow step 정의를 확인하겠습니다.\n");
    expect(progress).toHaveBeenCalledTimes(1);
    vi.setSystemTime(22_000);
    await h.log.onLog("stderr", "not stdout\n");
    expect(progress).toHaveBeenCalledTimes(1);
    await h.log.onLog("stdout", "");
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls[1]).toEqual(["assistant", expect.stringContaining("먼저 workflow step 정의를 확인하겠습니다.")]);
    await h.log.onLog("stdout", "");
    expect(progress).toHaveBeenCalledTimes(2);
  });
});
