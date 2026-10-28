import express from "express";
import request from "supertest";
import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import { createAppWorkflowToolStepExecutor } from "../app.js";
import { executeToolTest } from "../services/tools/test-executor.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(), getByKey: vi.fn(), listInstalled: vi.fn(), listByStatus: vi.fn(),
}));
const mockCore = vi.hoisted(() => ({ executeCoreWorkflowTool: vi.fn(), resolveRunStepEnv: vi.fn() }));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: {} }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/work-products.js", () => ({ workProductService: () => ({}) }));
vi.mock("../services/workflow/dag-engine.js", () => ({ completeWorkflowToolStepFromResult: vi.fn() }));
vi.mock("../services/workflow/core-tool-executor.js", () => mockCore);

const COMPANY_ID = "a1f6d7c4-063a-43a5-80ec-7235efb52101";
const TOOL = "fixture.plugin:publish";
const runContext = { agentId: "agent-1", runId: "run-1", companyId: COMPANY_ID };
const deferredBeforeStart = {
  kind: "deferred_before_start" as const, version: 1 as const, reasonCode: "runtime_shutting_down" as const,
  externalStarted: false as const, requestId: "request-1", executionId: "run-1", attemptId: "attempt-1", executionGeneration: 2,
};
const workflowIdentity = {
  requestId: deferredBeforeStart.requestId,
  executionId: deferredBeforeStart.executionId,
  attemptId: deferredBeforeStart.attemptId,
  executionGeneration: deferredBeforeStart.executionGeneration,
};

function deferredResult() {
  return {
    pluginId: "fixture.plugin", toolName: "publish", deferredBeforeStart,
    get result(): never { throw new Error("deferred result must not be read"); },
  };
}

function registeredRegistry(call: ReturnType<typeof vi.fn>) {
  const lifecycle = createRuntimeExecutionLifecycle();
  const registry = createPluginToolRegistry({ isRunning: vi.fn(() => true), call } as never, lifecycle);
  registry.registerPlugin("fixture.plugin", { tools: [{
    name: "publish", displayName: "Publish", description: "Publish fixture",
    parametersSchema: { type: "object" },
  }] } as never, "plugin-db-1");
  return { lifecycle, registry };
}

describe("plugin shutdown start boundary", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-shutdown-boundary-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: COMPANY_ID, name: "Plugin shutdown boundary" });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCore.resolveRunStepEnv.mockResolvedValue({});
    mockCore.executeCoreWorkflowTool.mockResolvedValue({ status: 404, body: { error: "not found" } });
    await db.delete(pluginToolExecutionReceipts);
  });

  function appFor(registered: boolean, executeTool = vi.fn()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-1", companyIds: [COMPANY_ID], source: "session" } as never;
      next();
    });
    app.use("/api", pluginRoutes(db, {} as never, undefined, undefined, { toolDispatcher: {
      listToolsForAgent: vi.fn(), getTool: vi.fn(() => registered ? { namespacedName: TOOL } : null), executeTool,
    } as never }, undefined));
    app.use(errorHandler);
    return app;
  }

  const post = (app: ReturnType<typeof appFor>, key: string) => request(app).post("/api/plugins/tools/execute")
    .send({ tool: TOOL, parameters: {}, runContext, idempotencyKey: key });

  it("dispatcher returns a deferral without reading normal result fields", async () => {
    const dispatcher = createPluginToolDispatcher();
    const executeTool = vi.fn().mockResolvedValue(deferredResult());
    dispatcher.getRegistry().executeTool = executeTool;

    await expect(dispatcher.executeTool(TOOL, {}, runContext, workflowIdentity)).resolves.toMatchObject({ deferredBeforeStart });
    expect(executeTool).toHaveBeenCalledWith(TOOL, {}, runContext, workflowIdentity);
  });

  it("blocks the actual plugin worker RPC when shutdown wins before start", async () => {
    const call = vi.fn();
    const { lifecycle, registry } = registeredRegistry(call);
    lifecycle.beginShutdown("SIGTERM");

    const result = await registry.executeTool(TOOL, {}, runContext as never, workflowIdentity);

    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pluginId: "fixture.plugin", toolName: "publish",
      deferredBeforeStart,
    });
  });

  it("passes the claimed workflow identity to the plugin start boundary", async () => {
    const executeTool = vi.fn().mockResolvedValue(deferredResult());
    const run = createAppWorkflowToolStepExecutor({
      db: {} as Db,
      toolDispatcher: { getTool: vi.fn(() => ({})), executeTool } as never,
      completeToolStep: vi.fn(),
      resolveStepEnv: vi.fn(),
    });

    await expect(run({
      companyId: COMPANY_ID,
      workflowRunId: workflowIdentity.executionId,
      workflowId: "workflow-1",
      stepId: "publish",
      stepRunId: workflowIdentity.attemptId,
      toolName: TOOL,
      args: {},
      requestId: workflowIdentity.requestId,
      executionGeneration: workflowIdentity.executionGeneration,
    })).resolves.toEqual({ deferredBeforeStart });
    expect(executeTool).toHaveBeenCalledWith(
      TOOL,
      {},
      expect.objectContaining({ runId: workflowIdentity.executionId, companyId: COMPANY_ID }),
      workflowIdentity,
    );
  });

  it("preserves a plugin result that started before shutdown", async () => {
    let finish!: (value: { content: string }) => void;
    const call = vi.fn(() => new Promise<{ content: string }>((resolve) => { finish = resolve; }));
    const { lifecycle, registry } = registeredRegistry(call);
    const pending = registry.executeTool(TOOL, {}, runContext as never);
    expect(call).toHaveBeenCalledTimes(1);

    lifecycle.beginShutdown("SIGTERM");
    finish({ content: "published" });

    await expect(pending).resolves.toMatchObject({ result: { content: "published" } });
  });

  it("plugin route releases the idempotency claim and never records a deferred success", async () => {
    const executeTool = vi.fn().mockResolvedValue(deferredResult());
    const app = appFor(true, executeTool);
    const first = await post(app, "plugin-deferred");
    const second = await post(app, "plugin-deferred");

    expect(first.status).toBe(503);
    expect(first.body).toEqual({ deferredBeforeStart });
    expect(second.headers["x-idempotent-replay"]).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(await db.select().from(pluginToolExecutionReceipts)).toHaveLength(0);
  });

  it("reports a deferred board tool test as unavailable instead of successful", async () => {
    const outcome = await executeToolTest({
      db: {} as Db,
      companyId: COMPANY_ID,
      tool: {
        id: "tool-1", companyId: COMPANY_ID, name: TOOL, description: "",
        inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
      input: {},
      dispatcher: {
        getTool: vi.fn(() => ({} as never)),
        executeTool: vi.fn().mockResolvedValue(deferredResult()),
      },
    });

    expect(outcome).toEqual({
      ok: false,
      status: "error",
      httpStatus: 503,
      error: "runtime_shutting_down",
    });
  });

  it("core route preserves the same deferral and releases its receipt", async () => {
    mockCore.executeCoreWorkflowTool.mockResolvedValue({ status: 503, body: {}, deferredBeforeStart });
    const response = await post(appFor(false), "core-deferred");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ deferredBeforeStart });
    expect(await db.select().from(pluginToolExecutionReceipts)).toHaveLength(0);
  });
});
