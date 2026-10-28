import express from "express";
import request from "supertest";
import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

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

function deferredResult() {
  return {
    pluginId: "fixture.plugin", toolName: "publish", deferredBeforeStart,
    get result(): never { throw new Error("deferred result must not be read"); },
  };
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
    dispatcher.getRegistry().executeTool = vi.fn().mockResolvedValue(deferredResult());

    await expect(dispatcher.executeTool(TOOL, {}, runContext)).resolves.toMatchObject({ deferredBeforeStart });
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

  it("core route preserves the same deferral and releases its receipt", async () => {
    mockCore.executeCoreWorkflowTool.mockResolvedValue({ status: 503, body: {}, deferredBeforeStart });
    const response = await post(appFor(false), "core-deferred");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ deferredBeforeStart });
    expect(await db.select().from(pluginToolExecutionReceipts)).toHaveLength(0);
  });
});
