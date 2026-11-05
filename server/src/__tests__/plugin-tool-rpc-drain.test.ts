import { fileURLToPath } from "node:url";
import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { PLUGIN_RPC_ERROR_CODES, type JsonRpcResponse } from "@paperclipai/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRetention, createWorkerRpc, type PendingRequest } from "../services/plugin-job-rpc.js";
import { claimToolExecutionReceipt, completeToolExecutionReceipt } from "../services/plugin-tool-execution-receipt.js";
import { createPluginWorkerManager, type PluginWorkerHandle, type PluginWorkerManager } from "../services/plugin-worker-manager.js";

const companyId = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b101";
const pluginId = "fixture-tool";
const entrypointPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
const params = (runId = "run-1") => ({ toolName: "write", parameters: { message: "test" },
  runContext: { agentId: "agent", companyId, projectId: "project", runId } });
const result = { content: "full result", data: { nested: [1, { value: "preserved" }] } };

async function bounded<T>(promise: Promise<T>, timeout = 5000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test barrier timed out")), timeout);
  })]); } finally { clearTimeout(timer); }
}
async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("observed plugin tool RPC retention", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let manager: PluginWorkerManager;
  let handle: PluginWorkerHandle;
  let events: Record<string, unknown>[];
  let current: ReturnType<PluginWorkerManager["observeTool"]> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-tool-rpc-drain-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Observed Tool Test" });
  }, 120_000);
  beforeEach(async () => {
    events = []; current = undefined; manager = createPluginWorkerManager();
    handle = await manager.startWorker(pluginId, {
      entrypointPath, manifest: {} as never, config: {}, apiVersion: 1, autoRestart: false,
      instanceInfo: { instanceId: "test", hostVersion: "1" },
      hostHandlers: { "state.get": async () => ({ from: "host" }) },
      onStreamNotification: (_method, value) => { events.push(value); },
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    if (current?.kind === "sent_or_unknown") {
      if (handle.status === "running") handle.notify("fixture.tool-release", { runId: "run-1", result });
      const outcome = await Promise.race([current.actual, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (outcome?.kind !== "unknown" && outcome !== null) current.acknowledge();
    }
    if (handle.retainedJobCount() === 0) await bounded(manager.stopAll());
    else {
      if (handle.status === "running") handle.notify("fixture.crash", {});
      void manager.stopAll();
    }
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });

  async function event(name: string) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const found = events.find((item) => item.event === name);
        if (found) resolve(found);
        else if (Date.now() >= deadline) reject(new Error(`missing fixture event: ${name}`));
        else setTimeout(poll, 5);
      };
      poll();
    });
  }
  function observe(timeout = 100) {
    const observation = manager.observeTool(pluginId, params(), timeout);
    current = observation;
    if (observation.kind !== "sent_or_unknown") throw new Error("tool was not sent");
    return observation;
  }

  it("closes legacy executeTool synchronously while an observed job drains", async () => {
    const job = handle.observeJob({ job: { runId: "held-job" } } as never, 10000);
    if (job.kind !== "sent_or_unknown") throw new Error("job was not sent");
    await event("started");
    const stopping = manager.stopAll();
    const attempt = handle.call("executeTool", params(), 500);
    try {
      const outcome = await Promise.race([
        attempt.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
      ]);
      if (outcome === "pending") await event("tool-started");
      expect(outcome).toBe("rejected");
    } finally {
      handle.notify("fixture.tool-release", { runId: "run-1", result });
      handle.notify("fixture.release", { runId: "held-job" });
      await bounded(job.actual); job.release();
      await bounded(Promise.allSettled([attempt, stopping]));
    }
  });

  it.each([["stopWorker", true], ["stopAll", true], ["stopWorker", false], ["stopAll", false]] as const)(
    "%s waits for actual result and database acknowledgement (timeout first: %s)", async (method, timeoutFirst) => {
      const claim = await claimToolExecutionReceipt(db, {
        companyId, runId: `${method}-${timeoutFirst}`, tool: "fixture:write", idempotencyKey: "one", parameters: {},
      });
      if (claim.kind !== "claim") throw new Error("receipt was not claimed");
      const obs = observe(timeoutFirst ? 100 : 1500);
      expect(await event("tool-started")).toMatchObject({ starts: 1, runId: "run-1" });
      const pid = handle.diagnostics().pid;
      const stop = method === "stopWorker" ? manager.stopWorker(pluginId) : manager.stopAll();
      expect(obs.acknowledge()).toBe(false);
      expect(manager.observeTool(pluginId, params("blocked"))).toEqual({ kind: "definitely_unsent" });
      await expect(handle.call("executeTool", params("blocked"))).rejects.toThrow();
      expect(await handle.call("health", {})).toEqual({ status: "ok" });
      handle.notify("fixture.host-call", {});
      expect(await event("host-response")).toMatchObject({ result: { from: "host" } });
      await pending(stop);
      expect(handle.diagnostics().pid).toBe(pid);
      expect(events.some((item) => item.event === "shutdown")).toBe(false);
      if (timeoutFirst) {
        await expect(obs.initial).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
          message: 'RPC call "executeTool" timed out after 100ms' });
        expect(handle.diagnostics().pendingRequests).toBe(1);
      }
      handle.notify("fixture.tool-release", { runId: "run-1", result });
      expect(await bounded(obs.actual)).toMatchObject({ kind: "result", result });
      if (!timeoutFirst) expect(await obs.initial).toEqual(result);
      expect(manager.retainedJobCount()).toBe(1);
      await pending(stop);
      expect(handle.diagnostics().pid).toBe(pid);
      expect(events.some((item) => item.event === "shutdown")).toBe(false);
      expect(events.filter((item) => item.event === "tool-started")).toHaveLength(1);
      const before = await db.select().from(pluginToolExecutionReceipts);
      expect(before.find((row) => row.id === claim.receiptId)).toMatchObject({ status: "executing" });
      await expect(db.transaction(async (tx) => {
        await tx.update(pluginToolExecutionReceipts).set({ status: "completed", resultStatus: 200, resultBody: result })
          .where(eq(pluginToolExecutionReceipts.id, claim.receiptId));
        throw new Error("forced finalization rollback");
      })).rejects.toThrow("forced finalization rollback");
      expect((await db.select().from(pluginToolExecutionReceipts)).find((row) => row.id === claim.receiptId))
        .toMatchObject({ status: "executing" });
      await pending(stop);
      await completeToolExecutionReceipt(db, claim.receiptId, { status: 200, body: result });
      const after = await db.select().from(pluginToolExecutionReceipts);
      expect(after.find((row) => row.id === claim.receiptId)).toMatchObject({ status: "completed", resultBody: result });
      await pending(stop);
      expect(obs.acknowledge()).toBe(true);
      expect(obs.acknowledge()).toBe(false);
      await bounded(stop);
      expect(handle.diagnostics()).toMatchObject({ status: "stopped", pid: null });
    }, 20000,
  );

  it.each([
    ["tool-result-error", false], ["json-rpc-error", false],
    ["tool-result-error", true], ["json-rpc-error", true],
  ] as const)("preserves the full %s (timeout first: %s)", async (kind, timeoutFirst) => {
    const obs = observe(timeoutFirst ? 100 : 1500);
    await event("tool-started");
    if (timeoutFirst) await expect(obs.initial).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT });
    const toolError = { error: "tool failure", data: { evidence: ["one", "two"] } };
    const rpcError = { code: -32021, message: "worker failure", data: { evidence: ["one", "two"] } };
    handle.notify("fixture.tool-release", kind === "tool-result-error"
      ? { runId: "run-1", result: toolError } : { runId: "run-1", error: rpcError });
    if (kind === "tool-result-error") {
      if (!timeoutFirst) expect(await obs.initial).toEqual(toolError);
      expect(await obs.actual).toMatchObject({ kind: "result", result: toolError });
    } else {
      if (!timeoutFirst) await expect(obs.initial).rejects.toMatchObject(rpcError);
      expect(await obs.actual).toMatchObject({ kind: "error", error: rpcError });
    }
    expect(obs.acknowledge()).toBe(true);
  });

  it("keeps an exited worker unknown, unacknowledged, and not replayed", async () => {
    const obs = observe(); await event("tool-started");
    handle.notify("fixture.crash", {});
    expect(await bounded(obs.actual)).toEqual({ kind: "unknown" });
    await expect(obs.initial).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE });
    expect(obs.acknowledge()).toBe(false);
    const stop = manager.stopAll();
    await pending(stop);
    expect(manager.observeTool(pluginId, params())).toEqual({ kind: "definitely_unsent" });
    expect(events.filter((item) => item.event === "tool-started")).toHaveLength(1);
    expect(manager.retainedJobCount()).toBe(1);
  });
});

describe("observed tool transport edge cases", () => {
  function seam(send: (bytes: string) => void, canSend = () => true) {
    const requests = new Map<string | number, PendingRequest>();
    const retention = createJobRetention();
    const rpc = createWorkerRpc({ pluginId, pending: requests, canSend, send, defaultTimeoutMs: 100,
      maxTimeoutMs: 1000, retention });
    const response = (message: JsonRpcResponse) => {
      const item = requests.get(message.id!);
      if (!item) throw new Error("missing correlation");
      clearTimeout(item.timer); requests.delete(message.id!); item.resolve(message);
    };
    return { rpc, requests, retention, response };
  }

  it("keeps the original timeout deadline and correlation until a late actual result", async () => {
    vi.useFakeTimers();
    try {
      const f = seam(() => undefined);
      const ordinary = f.rpc.call("executeTool", params());
      const ordinaryError = ordinary.then(() => null, (error) => error);
      const obs = f.rpc.observeTool(params());
      if (obs.kind !== "sent_or_unknown") throw new Error("tool was not sent");
      await vi.advanceTimersByTimeAsync(99); await pending(obs.initial); await pending(ordinary);
      await vi.advanceTimersByTimeAsync(1);
      const observedError = await obs.initial.then(() => null, (error) => error);
      expect(observedError).toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
        message: 'RPC call "executeTool" timed out after 100ms' });
      expect(await ordinaryError).toMatchObject({ code: observedError.code, message: observedError.message });
      expect(f.requests.size).toBe(1);
      f.response({ jsonrpc: "2.0", id: 2, result });
      expect(await obs.actual).toMatchObject({ kind: "result", result });
      expect(obs.acknowledge()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("retains correlation when a write accepts bytes and then throws", async () => {
    vi.useFakeTimers();
    try {
      let bytes = "";
      const f = seam((value) => { bytes = value; throw new Error("write failed"); });
      const obs = f.rpc.observeTool(params());
      if (obs.kind !== "sent_or_unknown") throw new Error("tool was not sent");
      await expect(obs.initial).rejects.toThrow('Failed to send "executeTool" to worker: write failed');
      expect(JSON.parse(bytes)).toMatchObject({ id: 1, method: "executeTool" });
      expect(obs.acknowledge()).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(f.requests.size).toBe(1);
      await pending(obs.actual);
      f.response({ jsonrpc: "2.0", id: 1, result });
      expect(await obs.actual).toMatchObject({ kind: "result", result });
      expect(obs.acknowledge()).toBe(true);
      expect(f.retention.count()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not treat a malformed response as an actual worker error", async () => {
    const f = seam(() => undefined);
    const obs = f.rpc.observeTool(params());
    if (obs.kind !== "sent_or_unknown") throw new Error("tool was not sent");
    f.response({ jsonrpc: "2.0", id: 1, error: { code: "bad", message: "bad" } } as never);
    expect(await obs.actual).toEqual({ kind: "unknown" });
    await expect(obs.initial).rejects.toThrow();
    expect(obs.acknowledge()).toBe(false);
    expect(f.retention.count()).toBe(1);
  });

  it("reports definitely unsent only before trying the transport", () => {
    const send = vi.fn();
    const f = seam(send, () => false);
    expect(f.rpc.observeTool(params())).toEqual({ kind: "definitely_unsent" });
    const circular: { self?: unknown } = {}; circular.self = circular;
    expect(seam(send).rpc.observeTool({ ...params(), parameters: circular })).toEqual({ kind: "definitely_unsent" });
    expect(send).not.toHaveBeenCalled();
    expect(f.retention.count()).toBe(0);
  });
});
