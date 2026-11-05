import express from "express";
import request from "supertest";
import { createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { createJobRetention, createWorkerRpc, type PendingRequest } from "../services/plugin-job-rpc.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { ObservedToolExecution } from "../services/plugin-tool-observation.js";
import {
  createRuntimeExecutionLifecycle, runtimeExecutionLifecycle,
  type RuntimeExecutionIdentity,
} from "../services/runtime-execution-lifecycle.js";

const TOOL = "fixture.plugin:publish";
const DB_ID = "b6bd0ce2-4189-49ee-b899-6083bb3f8286";
const context: ToolRunContext = { agentId: "agent", runId: "run-1", companyId: "company", projectId: "project" };
const identity: RuntimeExecutionIdentity = {
  requestId: "request-1", executionId: "run-1", attemptId: "attempt-1", executionGeneration: 4,
};

function retained(result: ObservedToolExecution) {
  if (result.kind !== "sent_or_unknown") throw new Error(`unexpected routing outcome ${result.kind}`);
  return result.observation;
}

function fixture(timeoutMs = 100) {
  const lifecycle = createRuntimeExecutionLifecycle();
  const events: string[] = [];
  let closeAtGate = false;
  vi.spyOn(runtimeExecutionLifecycle, "createScope").mockImplementation((raw) => {
    const scope = lifecycle.createScope(raw);
    return {
      ...scope,
      start(start) {
        events.push("gate");
        if (closeAtGate) lifecycle.beginShutdown("SIGTERM");
        return scope.start(start);
      },
    };
  });
  let available = true;
  let throwAfterWrite = false;
  const pending = new Map<string | number, PendingRequest>();
  const retention = createJobRetention();
  const sent: Array<{ jsonrpc: string; id: number; method: string; params: unknown }> = [];
  const rpc = createWorkerRpc({
    pluginId: DB_ID, pending, retention, defaultTimeoutMs: timeoutMs, maxTimeoutMs: timeoutMs,
    canSend: () => available,
    send(serialized) {
      events.push("send");
      sent.push(JSON.parse(serialized));
      if (throwAfterWrite) throw new Error("write uncertain");
    },
  });
  const observeTool = vi.fn((_pluginId: string, params: Parameters<typeof rpc.observeTool>[0]) => {
    events.push("observe");
    return rpc.observeTool(params);
  });
  const call = vi.fn((_pluginId: string, _method: "executeTool", params: Parameters<typeof rpc.observeTool>[0]) =>
    rpc.call("executeTool", params));
  const isRunning = vi.fn(() => available);
  const dispatcher = createPluginToolDispatcher({ workerManager: { observeTool, call, isRunning } as never });
  dispatcher.registerPluginTools("fixture.plugin", { tools: [{
    name: "publish", displayName: "Publish", description: "Publish", parametersSchema: { type: "object" },
  }] } as never, DB_ID);

  function settle(id: number, response: object) {
    const request = pending.get(id);
    if (!request) throw new Error(`missing pending request ${id}`);
    clearTimeout(request.timer);
    pending.delete(id);
    request.resolve(response as never);
  }
  function fail(id: number) {
    const request = pending.get(id);
    if (!request) throw new Error(`missing pending request ${id}`);
    clearTimeout(request.timer);
    pending.delete(id);
    request.fail(new Error("worker exited"));
  }
  return {
    dispatcher, lifecycle, events, sent, pending, retention, observeTool, call, isRunning, settle, fail,
    setAvailable(value: boolean) { available = value; },
    setThrowAfterWrite(value: boolean) { throwAfterWrite = value; },
    closeAtGate() { closeAtGate = true; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("observed plugin tool routing", () => {
  it("routes unchanged JSON values read from PostgreSQL and an HTTP body", async () => {
    vi.useRealTimers();
    const tempDb = await startEmbeddedPostgresTestDatabase("plugin-observed-json-");
    const db = createDb(tempDb.connectionString);
    try {
      const values = { text: "value", number: 3.25, boolean: false, nil: null, nested: [1, { text: "two" }] };
      const [row] = await db.execute(sql`select ${JSON.stringify(values)}::jsonb as parameters`);
      const f = fixture(5000);
      const app = express();
      app.use(express.json());
      app.post("/", (req, res) => {
        const routed = f.dispatcher.executeToolObserved(TOOL, req.body.parameters, req.body.context, identity);
        res.json({ kind: routed.kind });
      });
      await request(app).post("/").send({ parameters: row!.parameters, context }).expect(200, { kind: "sent_or_unknown" });
      expect(f.sent[0]!.params).toEqual({ toolName: "publish", parameters: values, runContext: context });
      const observation = f.observeTool.mock.results[0]!.value;
      if (observation.kind !== "sent_or_unknown") throw new Error("missing observation");
      f.settle(f.sent[0]!.id, { jsonrpc: "2.0", id: f.sent[0]!.id, result: { content: "done" } });
      await expect(observation.initial).resolves.toEqual({ content: "done" });
      expect(observation.acknowledge()).toBe(true);
      f.lifecycle.beginShutdown("SIGTERM");
      await request(app).post("/").send({ parameters: row!.parameters, context }).expect(200, { kind: "deferred_before_start" });
      expect(f.observeTool).toHaveBeenCalledTimes(1);
      expect(f.sent).toHaveLength(1);
    } finally {
      await db.$client.end({ timeout: 5 });
      await tempDb.cleanup();
    }
  }, 120_000);

  it("routes the exact DB UUID, inputs and identity under one immediate gate", async () => {
    const f = fixture();
    const parameters = { nested: { values: [1, "two"] } };
    const routed = f.dispatcher.executeToolObserved(TOOL, parameters, context, identity);
    const observation = retained(routed);
    expect(routed).toMatchObject({ pluginId: "fixture.plugin", toolName: "publish", identity });
    expect(observation).toBe(f.observeTool.mock.results[0]?.value);
    expect(f.observeTool).toHaveBeenCalledExactlyOnceWith(DB_ID, { toolName: "publish", parameters, runContext: context });
    expect(f.observeTool.mock.calls[0]?.[1].parameters).toBe(parameters);
    expect(f.observeTool.mock.calls[0]?.[1].runContext).toBe(context);
    expect(f.events).toEqual(["gate", "observe", "send"]);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.isRunning).not.toHaveBeenCalled();
    const result = { content: "done", data: { nested: [1, 2] }, error: "tool error" };
    const response = { jsonrpc: "2.0", id: f.sent[0]!.id, result };
    f.settle(response.id, response);
    await expect(observation.initial).resolves.toEqual(result);
    await expect(observation.actual).resolves.toEqual({ kind: "result", result, response });
    expect(observation.state()).toBe("settled");
    expect(f.retention.count()).toBe(1);
    expect(observation.acknowledge()).toBe(true);
    expect(observation.acknowledge()).toBe(false);
    expect(f.retention.count()).toBe(0);
  });

  it("preserves the original timeout while forwarding a late full result without automatic acknowledgement", async () => {
    const f = fixture();
    const observation = retained(f.dispatcher.executeToolObserved(TOOL, {}, context, identity));
    const initial = expect(observation.initial).rejects.toMatchObject({ code: expect.any(Number), message: 'RPC call "executeTool" timed out after 100ms' });
    await vi.advanceTimersByTimeAsync(100);
    await initial;
    expect(observation.state()).toBe("pending");
    expect(observation.acknowledge()).toBe(false);
    const result = { content: "late", data: { records: [{ value: 42 }] } };
    const response = { jsonrpc: "2.0", id: f.sent[0]!.id, result };
    f.settle(response.id, response);
    await expect(observation.actual).resolves.toEqual({ kind: "result", result, response });
    expect(f.retention.count()).toBe(1);
    expect(observation.acknowledge()).toBe(true);
  });

  it("forwards full late JSON-RPC errors and their original initial rejection", async () => {
    const f = fixture();
    const observation = retained(f.dispatcher.executeToolObserved(TOOL, {}, context, identity));
    const initial = expect(observation.initial).rejects.toThrow('RPC call "executeTool" timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await initial;
    const error = { code: -32001, message: "worker error", data: { detail: ["full", 1] } };
    const response = { jsonrpc: "2.0", id: f.sent[0]!.id, error };
    f.settle(response.id, response);
    await expect(observation.actual).resolves.toEqual({ kind: "error", error, response });
    expect(f.retention.count()).toBe(1);
    expect(observation.acknowledge()).toBe(true);
  });

  it("defers at global closure immediately before RPC with the exact existing control contract", () => {
    const f = fixture();
    f.closeAtGate();
    const routed = f.dispatcher.executeToolObserved(TOOL, { a: 1 }, context, identity);
    expect(routed).toEqual({
      kind: "deferred_before_start", pluginId: "fixture.plugin", toolName: "publish", identity,
      deferredBeforeStart: { kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down", externalStarted: false, ...identity },
    });
    expect(f.events).toEqual(["gate"]);
    expect(f.observeTool).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("reports plugin closure and serialization failure as unsent without inventing shutdown", () => {
    const f = fixture();
    f.setAvailable(false);
    const closed = f.dispatcher.executeToolObserved(TOOL, {}, context, identity);
    expect(closed).toEqual({ kind: "definitely_unsent", pluginId: "fixture.plugin", toolName: "publish", identity });
    expect(closed).not.toHaveProperty("deferredBeforeStart");
    expect(closed).not.toHaveProperty("externalStarted");
    f.setAvailable(true);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const invalid = f.dispatcher.executeToolObserved(TOOL, cyclic, context, identity);
    expect(invalid.kind).toBe("definitely_unsent");
    expect(invalid).not.toHaveProperty("deferredBeforeStart");
    expect(f.sent).toHaveLength(0);
    expect(f.retention.count()).toBe(0);
  });

  it("keeps ambiguous writes and worker loss unknown, never unsent or acknowledged", async () => {
    const f = fixture();
    f.setThrowAfterWrite(true);
    const routed = f.dispatcher.executeToolObserved(TOOL, {}, context, identity);
    const observation = retained(routed);
    await expect(observation.initial).rejects.toThrow("write uncertain");
    expect(observation.state()).toBe("unknown");
    expect(observation.acknowledge()).toBe(false);
    expect(f.retention.count()).toBe(1);
    const result = { content: "arrived despite write exception" };
    const response = { jsonrpc: "2.0", id: f.sent[0]!.id, result };
    f.settle(response.id, response);
    await expect(observation.actual).resolves.toEqual({ kind: "result", result, response });
    expect(observation.acknowledge()).toBe(true);
    f.setThrowAfterWrite(false);
    const lost = retained(f.dispatcher.executeToolObserved(TOOL, {}, context, { ...identity, requestId: "request-2" }));
    f.fail(f.sent[1]!.id);
    await expect(lost.initial).rejects.toThrow("worker exited");
    await expect(lost.actual).resolves.toEqual({ kind: "unknown" });
    expect(lost.state()).toBe("unknown");
    expect(lost.acknowledge()).toBe(false);
    expect(f.retention.count()).toBe(1);
    expect(f.observeTool).toHaveBeenCalledTimes(2);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rejects invalid or mismatched identity and preserves ordinary name checks", async () => {
    const f = fixture();
    for (const bad of [
      { ...identity, requestId: "" }, { ...identity, executionGeneration: -1 },
      { ...identity, attemptId: " " }, { ...identity, extra: true }, { ...identity, executionId: "other-run" },
      { ...identity, requestId: " request-1 " }, { ...identity, attemptId: " attempt-1 " },
      { ...identity, executionId: " run-1 " },
    ]) expect(() => f.dispatcher.executeToolObserved(TOOL, {}, context, bad)).toThrow();
    expect(() => f.dispatcher.executeToolObserved("bad", {}, context, identity)).toThrow('Invalid tool name "bad"');
    expect(f.dispatcher.executeToolObserved("fixture.plugin:missing", {}, context, identity)).toEqual({
      kind: "definitely_unsent", pluginId: "fixture.plugin", toolName: "missing", identity,
    });
    await expect(f.dispatcher.executeTool("bad", {}, context)).rejects.toThrow('Invalid tool name "bad"');
    await expect(f.dispatcher.executeTool("fixture.plugin:missing", {}, context)).rejects.toThrow("is not registered");
    expect(f.observeTool).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });

  it("reports unregister and missing-manager failures as definitely unsent", () => {
    const f = fixture();
    f.dispatcher.unregisterPluginTools("fixture.plugin");
    expect(f.dispatcher.executeToolObserved(TOOL, {}, context, identity)).toMatchObject({ kind: "definitely_unsent", identity });
    expect(f.observeTool).not.toHaveBeenCalled();
    const noManager = createPluginToolDispatcher();
    noManager.registerPluginTools("fixture.plugin", { tools: [{ name: "publish", displayName: "Publish",
      description: "Fixture", parametersSchema: { type: "object" } }] } as never, DB_ID);
    expect(noManager.executeToolObserved(TOOL, {}, context, identity)).toMatchObject({ kind: "definitely_unsent", identity });
  });

  it("keeps two simultaneous call identities, contexts and observations isolated", async () => {
    const f = fixture();
    const secondContext = { ...context, runId: "run-2", companyId: "company-2" };
    const secondIdentity = { ...identity, requestId: "request-2", executionId: "run-2", attemptId: "attempt-2", executionGeneration: 9 };
    const first = f.dispatcher.executeToolObserved(TOOL, { order: 1 }, context, identity);
    const second = f.dispatcher.executeToolObserved(TOOL, { order: 2 }, secondContext, secondIdentity);
    const a = retained(first);
    const b = retained(second);
    expect(first.identity).toEqual(identity);
    expect(second.identity).toEqual(secondIdentity);
    expect(f.sent.map((wire) => wire.params)).toEqual([
      { toolName: "publish", parameters: { order: 1 }, runContext: context },
      { toolName: "publish", parameters: { order: 2 }, runContext: secondContext },
    ]);
    const responseB = { jsonrpc: "2.0", id: f.sent[1]!.id, result: { content: "second" } };
    const responseA = { jsonrpc: "2.0", id: f.sent[0]!.id, result: { content: "first" } };
    f.settle(responseB.id, responseB);
    f.settle(responseA.id, responseA);
    await expect(a.actual).resolves.toEqual({ kind: "result", result: responseA.result, response: responseA });
    await expect(b.actual).resolves.toEqual({ kind: "result", result: responseB.result, response: responseB });
    expect(f.retention.count()).toBe(2);
    expect(a.acknowledge()).toBe(true);
    expect(f.retention.count()).toBe(1);
    expect(b.acknowledge()).toBe(true);
  });

  it("preserves serializable ordinary results and error propagation", async () => {
    const f = fixture();
    const execution = f.dispatcher.executeTool(TOOL, { old: true }, context);
    const result = { content: "legacy", data: { value: 1 } };
    f.settle(f.sent[0]!.id, { jsonrpc: "2.0", id: f.sent[0]!.id, result });
    const response = await execution;
    expect(JSON.parse(JSON.stringify(response))).toEqual({ pluginId: "fixture.plugin", toolName: "publish", result });
    expect(response).not.toHaveProperty("observation");
    const failure = f.dispatcher.executeTool(TOOL, {}, context);
    f.settle(f.sent[1]!.id, { jsonrpc: "2.0", id: f.sent[1]!.id, error: { code: -32002, message: "legacy failure", data: { a: 1 } } });
    await expect(failure).rejects.toMatchObject({ code: -32002, message: "legacy failure", data: { a: 1 } });
    expect(f.observeTool).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.retention.count()).toBe(0);
  });
});
