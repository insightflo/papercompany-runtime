import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginWorkerManager, type PluginWorkerHandle, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { decodeRetainedToolOutcome, insertInternalToolReceipt, releaseRetainedHttpToolUnsentReceipt, stageRetainedToolOutcome, type RetainedToolRequest } from "../services/plugin-tool-execution-receipt.js";
import type { RuntimeExecutionIdentity } from "../services/runtime-execution-lifecycle.js";
const mocks = vi.hoisted(() => ({
  registry: { getById: vi.fn(), getByKey: vi.fn(), listInstalled: vi.fn(), listByStatus: vi.fn() },
  core: { resolveRunStepEnv: vi.fn(), executePluginCoreToolCall: vi.fn() },
}));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mocks.registry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: {} }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/work-products.js", () => ({ workProductService: () => ({}) }));
vi.mock("../services/workflow/dag-engine.js", () => ({ completeWorkflowToolStepFromResult: vi.fn() }));
vi.mock("../services/workflow/core-tool-executor.js", () => ({ resolveRunStepEnv: mocks.core.resolveRunStepEnv }));
vi.mock("../services/workflow/plugin-core-tool-call.js", () => ({ executePluginCoreToolCall: mocks.core.executePluginCoreToolCall }));
const COMPANY = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b001";
const TOOL = "fixture.plugin:publish";
const PLUGIN_DB_ID = "fixture-plugin-worker";
const workerPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
const runContext = () => ({ agentId: "agent-1", runId: randomUUID(), companyId: COMPANY });
const actual = { kind: "result" as const, result: { content: "full", data: { retained: true } }, response: { jsonrpc: "2.0" as const, id: 7, result: { content: "full", data: { retained: true } } } };
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function turn() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitUntil(check: () => Promise<boolean> | boolean) { for (let i = 0; i < 500; i += 1) { if (await check()) return; await turn(); } throw new Error("HTTP consumer state did not settle"); }
function proof(owner: RetainedToolRequest, fields: Record<string, unknown> = {}) { const identity = { requestId: owner.receiptId, executionId: owner.identity.runId, attemptId: owner.receiptId, executionGeneration: 1 }; return { kind: "definitely_unsent", pluginId: "fixture.plugin", toolName: "publish", identity, ...fields }; }
function captureActuals(dispatcher: ReturnType<typeof createPluginToolDispatcher>) {
  const actuals = new Map<string, unknown>(), execute = dispatcher.executeToolObserved.bind(dispatcher);
  dispatcher.executeToolObserved = (...args) => { const observed = execute(...args); if (observed.kind === "sent_or_unknown") void observed.observation.actual.then((value) => actuals.set(args[3].requestId, value)); return observed; };
  return actuals;
}
describe("retained HTTP plugin tool consumer", () => {
  let db!: Db;
  let tempDb!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let manager: PluginWorkerManager | undefined;
  let handle: PluginWorkerHandle | undefined;
  let stream = new EventEmitter();
  let started: Record<string, unknown>[] = [];
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-tool-http-consumer-");
    db = createDb(tempDb.connectionString); await db.insert(companies).values({ id: COMPANY, name: "HTTP plugin consumer test" });
  }, 120_000);
  beforeEach(async () => {
    stream = new EventEmitter(); started = []; manager = undefined; handle = undefined;
    vi.clearAllMocks();
    mocks.core.resolveRunStepEnv.mockResolvedValue({});
    await db.delete(pluginToolExecutionReceipts);
  });
  afterEach(async () => {
    for (const event of started) handle?.notify("fixture.tool-release", { runId: event.runId, result: { content: "cleanup" } });
    await manager?.stopAll();
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });
  function app(dbArg: Db, dispatcher: Record<string, unknown>) {
    const server = express(); server.use(express.json()); server.use((req, _res, next) => { req.actor = { type: "board", userId: "board", companyIds: [COMPANY], source: "session" } as never; next(); });
    server.use("/api", pluginRoutes(dbArg, {} as never, undefined, undefined, { toolDispatcher: dispatcher } as never, undefined));
    server.use(errorHandler); return server;
  }
  const post = (server: ReturnType<typeof app>, body: Record<string, unknown>) => request(server).post("/api/plugins/tools/execute").send(body);
  const startPost = (server: ReturnType<typeof app>, body: Record<string, unknown>) => post(server, body).then((response) => response);
  const rows = () => db.select().from(pluginToolExecutionReceipts);
  const waitStart = () => new Promise<Record<string, unknown>>((resolve) => stream.once("started", resolve));
  async function realWorker(dbArg: Db = db, rpcTimeoutMs = 60) {
    manager = createPluginWorkerManager();
    handle = await manager.startWorker(PLUGIN_DB_ID, {
      entrypointPath: workerPath, manifest: {} as never, config: {}, apiVersion: 1, autoRestart: false,
      rpcTimeoutMs, instanceInfo: { instanceId: "http-test", hostVersion: "test" }, hostHandlers: { "state.get": async () => ({}) },
      onStreamNotification: (_method, value) => {
        const event = value as Record<string, unknown>;
        if (event.event === "tool-started") { started.push(event); stream.emit("started", event); }
      },
    });
    const dispatcher = createPluginToolDispatcher({ workerManager: manager });
    dispatcher.registerPluginTools("fixture.plugin", { tools: [{ name: "publish", displayName: "Publish",
      description: "Publish", parametersSchema: { type: "object" } }] } as never, PLUGIN_DB_ID);
    return { server: app(dbArg, dispatcher as unknown as Record<string, unknown>), dispatcher };
  }
  it("keeps keyed late results held, returns provisional timeout, then replays the actual response", async () => {
    const f = await realWorker(); const actuals = captureActuals(f.dispatcher); const run = runContext(), wait = waitStart();
    const first = startPost(f.server, { tool: TOOL, parameters: { q: 1 }, runContext: run, idempotencyKey: "late" });
    const event = await wait; expect(event.runId).toBe(run.runId); const timeout = await first;
    expect(timeout.status).toBe(500);
    expect(timeout.body.error).toBe('RPC call "executeTool" timed out after 60ms');
    expect((await post(f.server, { tool: TOOL, runContext: run, idempotencyKey: "late" })).status).toBe(409);
    expect(started).toHaveLength(1);
    handle!.notify("fixture.tool-release", { runId: event.runId, result: actual.result });
    await waitUntil(async () => (await rows())[0]?.status === "completed");
    expect(manager!.retainedJobCount()).toBe(0);
    const replay = await post(f.server, { tool: TOOL, runContext: run, idempotencyKey: "late" });
    expect(replay.status).toBe(200); expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.body).toEqual({ pluginId: "fixture.plugin", toolName: "publish", result: actual.result });
    const completed = (await rows())[0]!; expect(decodeRetainedToolOutcome(completed.resultBody)?.actual).toEqual(actuals.get(completed.id));
  });
  it("stores unkeyed late results and holds worker shutdown until the receipt commit", async () => {
    const stageEntered = gate(), rejectStage = gate(), stageRejected = gate(), retryStage = gate(), commitStage = gate(), completionCommitted = gate(), rejectCompletion = gate();
    let fail = true, rollingBack = false, hold = true, stageCommitted = false, rejectNextComplete = false;
    const gatedDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      const transaction = target.transaction.bind(target);
      return (callback: Parameters<typeof db.transaction>[0]) => transaction(async (tx) => {
        const result = await callback(tx);
        if (fail) { fail = false; rollingBack = true; stageEntered.resolve(); await rejectStage.promise; throw new Error("injected stage rollback"); }
        if (hold) { hold = false; retryStage.resolve(); await commitStage.promise; stageCommitted = true; }
        return result;
      }).catch((error) => { if (rollingBack) { rollingBack = false; stageRejected.resolve(); } throw error; }).then(async (result) => {
        if (stageCommitted) { stageCommitted = false; rejectNextComplete = true; }
        else if (rejectNextComplete) { rejectNextComplete = false; completionCommitted.resolve(); await rejectCompletion.promise; throw new Error("caller rejected committed completion"); }
        return result;
      });
    } }) as Db;
    const f = await realWorker(gatedDb); const actuals = captureActuals(f.dispatcher); const run = runContext(), firstWait = waitStart();
    try {
    const first = startPost(f.server, { tool: TOOL, runContext: run }); const firstEvent = await firstWait;
    expect(firstEvent.runId).toBe(run.runId); const firstTimeout = await first;
    expect(firstTimeout.status).toBe(500); expect(firstTimeout.body.error).toBe('RPC call "executeTool" timed out after 60ms');
    const original = (await rows())[0]!; handle!.notify("fixture.tool-release", { runId: firstEvent.runId, result: actual.result });
    await stageEntered.promise; const secondWait = waitStart(), second = startPost(f.server, { tool: TOOL, runContext: run }); const secondEvent = await secondWait;
    expect(secondEvent.runId).toBe(run.runId); const secondTimeout = await second;
    expect(secondTimeout.status).toBe(500); expect(secondTimeout.body.error).toBe('RPC call "executeTool" timed out after 60ms');
    const receipts = await rows(); expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((row) => row.id)).size).toBe(2); expect(new Set(receipts.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(receipts.every((row) => row.runId === run.runId)).toBe(true);
    rejectStage.resolve(); await stageRejected.promise;
    const stopping = manager!.stopWorker(PLUGIN_DB_ID); let stopped = false; void stopping.then(() => { stopped = true; });
    expect((await rows()).find((row) => row.id === original.id)).toMatchObject({ status: "executing", resultBody: null, resultStatus: null, completedAt: null });
    await turn(); expect(stopped).toBe(false); await retryStage.promise;
    handle!.notify("fixture.tool-release", { runId: secondEvent.runId, result: actual.result });
    await waitUntil(async () => (await rows()).find((row) => row.id !== original.id)?.status === "completed");
    expect(manager!.retainedJobCount()).toBe(1); expect(stopped).toBe(false);
    expect((await rows()).find((row) => row.id === original.id)).toMatchObject({ status: "executing", resultBody: null, resultStatus: null, completedAt: null });
    commitStage.resolve(); await completionCommitted.promise;
    const commitProof = (await rows()).find((row) => row.id === original.id)!;
    expect(commitProof).toMatchObject({ status: "completed", workflowRunId: null, stepId: null });
    expect(decodeRetainedToolOutcome(commitProof.resultBody)?.actual).toEqual(actuals.get(original.id));
    const completedAt = commitProof.completedAt!.getTime(), resultBody = commitProof.resultBody;
    expect(manager!.retainedJobCount()).toBe(1); expect(stopped).toBe(false);
    rejectCompletion.resolve(); await stopping;
    const completed = (await rows()).find((row) => row.id === original.id)!;
    expect(completed.completedAt!.getTime()).toBe(completedAt); expect(completed.resultBody).toEqual(resultBody);
    expect(decodeRetainedToolOutcome(completed.resultBody)?.actual).toEqual(actuals.get(original.id));
    expect(manager!.retainedJobCount()).toBe(0); expect(started).toHaveLength(2);
    } finally { rejectStage.resolve(); commitStage.resolve(); rejectCompletion.resolve(); }
  });
  it("holds disconnects and acknowledgement failures without releasing worker retention", async () => {
    const f = await realWorker(); const wait = waitStart(); const client = post(f.server, { tool: TOOL, runContext: runContext() });
    client.end(() => {}); const event = await wait; client.abort(); await turn();
    expect(manager!.retainedJobCount()).toBe(1);
    handle!.notify("fixture.tool-release", { runId: event.runId, result: actual.result });
    await waitUntil(async () => (await rows())[0]?.status === "completed");
    expect(manager!.retainedJobCount()).toBe(0);
    let transactions = 0; const countedDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      const transaction = target.transaction.bind(target);
      return (callback: Parameters<typeof db.transaction>[0]) => { transactions += 1; return transaction(callback); };
    } }) as Db;
    const acknowledgeThrows = vi.fn((): boolean => { throw new Error("acknowledgement failed"); });
    const acknowledgeRefuses = vi.fn((): boolean => false); let nextAcknowledge = acknowledgeThrows;
    const dispatcher = { getTool: vi.fn(() => ({ namespacedName: TOOL })), executeTool: vi.fn(), listToolsForAgent: vi.fn(), executeToolObserved: vi.fn(
      (_t: string, _p: unknown, _c: unknown, identity: RuntimeExecutionIdentity) => ({ kind: "sent_or_unknown" as const, pluginId: "fixture.plugin", toolName: "publish", identity,
        observation: { initial: Promise.resolve(actual.result), actual: Promise.resolve(actual), state: () => "settled" as const, acknowledge: nextAcknowledge } })) };
    expect((await post(app(countedDb, dispatcher), { tool: TOOL, runContext: runContext() })).status).toBe(500); nextAcknowledge = acknowledgeRefuses;
    expect((await post(app(countedDb, dispatcher), { tool: TOOL, runContext: runContext() })).status).toBe(500);
    expect(acknowledgeThrows).toHaveBeenCalledTimes(1); expect(acknowledgeRefuses).toHaveBeenCalledTimes(1); expect(transactions).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(acknowledgeThrows).toHaveBeenCalledTimes(1); expect(acknowledgeRefuses).toHaveBeenCalledTimes(1); expect(transactions).toBe(4);
  });
  it("preserves ToolResult.error and JSON-RPC error payloads with legacy HTTP mapping", async () => {
    const f = await realWorker();
    const firstWait = waitStart(); const firstRequest = startPost(f.server, { tool: TOOL, runContext: runContext(), idempotencyKey: "tool-error" });
    const firstEvent = await firstWait;
    handle!.notify("fixture.tool-release", { runId: firstEvent.runId, result: { content: "", error: "tool rejected", data: { full: 1 } } });
    const toolError = await firstRequest; expect(toolError.status).toBe(200); expect(toolError.body.result.error).toBe("tool rejected");
    const rpcWait = waitStart(); const rpcRequest = startPost(f.server, { tool: TOOL, runContext: runContext(), idempotencyKey: "rpc-error" });
    const rpcEvent = await rpcWait;
    handle!.notify("fixture.tool-release", { runId: rpcEvent.runId, error: { code: -32007, message: "worker rejected", data: { full: 2 } } });
    const rpcError = await rpcRequest; expect(rpcError.status).toBe(502); expect(rpcError.body.error).toBe("worker rejected");
    await waitUntil(async () => (await rows()).length === 2 && (await rows()).every((row) => row.status === "completed"));
    const outcomes = (await rows()).map((row) => decodeRetainedToolOutcome(row.resultBody)?.actual);
    expect(outcomes).toContainEqual({ kind: "result", result: { content: "", error: "tool rejected", data: { full: 1 } }, response: expect.any(Object) });
    expect(outcomes).toContainEqual({ kind: "error", error: { code: -32007, message: "worker rejected", data: { full: 2 } }, response: expect.any(Object) });
  });
  it("keeps unknown executions executing past the old age threshold without takeover", async () => {
    const dispatcher = {
      getTool: vi.fn(() => ({ namespacedName: TOOL })), executeTool: vi.fn(), listToolsForAgent: vi.fn(),
      executeToolObserved: vi.fn((_tool: string, _params: unknown, _context: unknown, identity: RuntimeExecutionIdentity) => ({ kind: "sent_or_unknown", pluginId: "fixture.plugin",
        toolName: "publish", identity, observation: { initial: Promise.reject(new Error("worker exited")), actual: Promise.resolve({ kind: "unknown" }),
          state: () => "unknown", acknowledge: () => false } })),
    };
    const server = app(db, dispatcher); const run = runContext();
    const first = await post(server, { tool: TOOL, runContext: run, idempotencyKey: "lost" }); expect(first.status).toBe(502);
    const [row] = await rows(); await db.update(pluginToolExecutionReceipts).set({ claimedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(pluginToolExecutionReceipts.id, row!.id));
    const retry = await post(server, { tool: TOOL, runContext: run, idempotencyKey: "lost" });
    expect(retry.status).toBe(409); expect(dispatcher.executeToolObserved).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ status: "executing", resultBody: null, resultStatus: null, completedAt: null });
    await db.insert(pluginToolExecutionReceipts).values({ companyId: COMPANY, runId: run.runId, tool: TOOL,
      idempotencyKey: "legacy", status: "executing", requestParameters: {}, claimedAt: new Date("2020-01-01T00:00:00Z") });
    expect((await post(server, { tool: TOOL, runContext: run, idempotencyKey: "legacy" })).status).toBe(409);
    expect(dispatcher.executeToolObserved).toHaveBeenCalledTimes(1);
  });
  it("releases a keyed claim after a direct positive definitely-unsent observation", async () => {
    const dispatcher = {
      getTool: vi.fn(() => ({ namespacedName: TOOL })), executeTool: vi.fn(), listToolsForAgent: vi.fn(),
      executeToolObserved: vi.fn((_tool: string, _params: unknown, _context: unknown, identity: RuntimeExecutionIdentity) => ({
        kind: "definitely_unsent", pluginId: "fixture.plugin", toolName: "publish", identity,
      })),
    };
    const server = app(db, dispatcher); const run = runContext();
    const first = await post(server, { tool: TOOL, runContext: run, idempotencyKey: "not-sent" });
    expect(first.status).toBe(502); expect(dispatcher.executeToolObserved).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(0);
  });
  it("releases only direct matching unsent proof, and keeps staged, JSON-null, or competing outcomes held", async () => {
    const owner = () => insertInternalToolReceipt(db, { companyId: COMPANY, tool: TOOL, parameters: {}, consumer: "http-internal" });
    for (const bad of [
      (o: RetainedToolRequest) => proof(o, { identity: { ...((proof(o).identity as object)), attemptId: "wrong" } }),
      (o: RetainedToolRequest) => proof(o, { pluginId: "other.plugin" }),
      (o: RetainedToolRequest) => ({ ...proof(o), kind: "sent_or_unknown", observation: {} }),
      (o: RetainedToolRequest) => ({ ...proof(o), kind: "unknown" }),
      (o: RetainedToolRequest) => ({ ...proof(o), kind: "deferred_before_start", deferredBeforeStart: {
        ...(proof(o).identity as object), kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down", externalStarted: true,
      } }),
    ]) {
      const o = await owner(); expect((await releaseRetainedHttpToolUnsentReceipt(db, o, bad(o) as never)).kind).toBe("held");
    }
    const staged = await owner(); await stageRetainedToolOutcome(db, staged, actual);
    expect((await releaseRetainedHttpToolUnsentReceipt(db, staged, proof(staged) as never)).kind).toBe("held");
    const jsonNull = await owner();
    await db.update(pluginToolExecutionReceipts).set({ resultBody: sql`'null'::jsonb` }).where(eq(pluginToolExecutionReceipts.id, jsonNull.receiptId));
    expect((await releaseRetainedHttpToolUnsentReceipt(db, jsonNull, proof(jsonNull) as never)).kind).toBe("held");
    for (const change of [{ resultStatus: 200 }, { completedAt: new Date() }, { workflowRunId: randomUUID() }, { stepId: "step" }]) {
      const changed = await owner();
      await db.update(pluginToolExecutionReceipts).set(change).where(eq(pluginToolExecutionReceipts.id, changed.receiptId));
      expect((await releaseRetainedHttpToolUnsentReceipt(db, changed, proof(changed) as never)).kind).toBe("held");
    }
    const workflowOwner = await insertInternalToolReceipt(db, { companyId: COMPANY, tool: TOOL, parameters: {}, consumer: "workflow",
      workflow: { missionId: null, workflowRunId: randomUUID(), stepRunId: randomUUID(), stepId: "step", requestId: randomUUID(),
        executionGeneration: 1, statusTransitionVersion: 1, runStatus: "running", stepStatus: "running", acceptedAt: new Date().toISOString() } });
    expect((await releaseRetainedHttpToolUnsentReceipt(db, workflowOwner, proof(workflowOwner) as never)).kind).toBe("held");
    const released = await owner();
    expect(await releaseRetainedHttpToolUnsentReceipt(db, released, proof(released) as never)).toEqual({ kind: "released", receiptId: released.receiptId });
    expect((await releaseRetainedHttpToolUnsentReceipt(db, released, proof(released) as never)).kind).toBe("held");
    const deferredOwner = await owner(); const deferred = { ...proof(deferredOwner), kind: "deferred_before_start",
      deferredBeforeStart: { ...(proof(deferredOwner).identity as object), kind: "deferred_before_start", version: 1,
        reasonCode: "runtime_shutting_down", externalStarted: false } };
    expect((await releaseRetainedHttpToolUnsentReceipt(db, deferredOwner, deferred as never)).kind).toBe("released");
  });
  it("serializes release and actual staging in either lock order", async () => {
    const stagedOwner = await insertInternalToolReceipt(db, { companyId: COMPANY, tool: TOOL, parameters: {}, consumer: "http-internal" });
    const stageReady = gate(), stageCommit = gate(); let stageHold = true;
    const stageDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      const transaction = target.transaction.bind(target);
      return (callback: Parameters<typeof db.transaction>[0]) => transaction(async (tx) => {
        const value = await callback(tx); if (stageHold) { stageHold = false; stageReady.resolve(); await stageCommit.promise; } return value;
      });
    } }) as Db;
    const stageFirst = stageRetainedToolOutcome(stageDb, stagedOwner, actual); await stageReady.promise;
    const releaseAfter = releaseRetainedHttpToolUnsentReceipt(db, stagedOwner, proof(stagedOwner) as never);
    await turn(); stageCommit.resolve(); await stageFirst; expect((await releaseAfter).kind).toBe("held");
    const releasedOwner = await insertInternalToolReceipt(db, { companyId: COMPANY, tool: TOOL, parameters: {}, consumer: "http-internal" });
    const deleteReady = gate(), deleteCommit = gate(); let deleteHold = true;
    const deleteDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      const transaction = target.transaction.bind(target);
      return (callback: Parameters<typeof db.transaction>[0]) => transaction(async (tx) => {
        const value = await callback(tx); if (deleteHold) { deleteHold = false; deleteReady.resolve(); await deleteCommit.promise; } return value;
      });
    } }) as Db;
    const releaseFirst = releaseRetainedHttpToolUnsentReceipt(deleteDb, releasedOwner, proof(releasedOwner) as never);
    await deleteReady.promise;
    const stageAfter = stageRetainedToolOutcome(db, releasedOwner, actual).then(() => "staged", () => "missing");
    await turn(); deleteCommit.resolve(); expect((await releaseFirst).kind).toBe("released"); expect(await stageAfter).toBe("missing");
  });
  it("keeps the core/in-process route on its existing receipt path", async () => {
    const executeToolObserved = vi.fn(); const dispatcher = {
      getTool: vi.fn(() => null), executeToolObserved, executeTool: vi.fn(), listToolsForAgent: vi.fn(),
    };
    mocks.core.executePluginCoreToolCall.mockResolvedValue({ status: 200, body: { source: "core", content: "ok" } });
    const server = app(db, dispatcher); const body = { tool: "daily-tech-scout", runContext: runContext(), idempotencyKey: "core" };
    const first = await post(server, body); const replay = await post(server, body);
    expect(first.body).toEqual({ source: "core", content: "ok" }); expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(executeToolObserved).not.toHaveBeenCalled(); expect((await rows())[0]?.requestParameters).toEqual({});
  });
});
