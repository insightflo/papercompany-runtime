import express from "express";
import request from "supertest";
import {
  createDb,
  pluginToolExecutionReceipts,
  companies,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(), getByKey: vi.fn(), listInstalled: vi.fn(), listByStatus: vi.fn(),
}));
const mockCoreExecutor = vi.hoisted(() => ({
  executeCoreWorkflowTool: vi.fn(),
  resolveRunStepEnv: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: {} }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/work-products.js", () => ({ workProductService: () => ({}) }));
vi.mock("../services/workflow/dag-engine.js", () => ({
  completeWorkflowToolStepFromResult: vi.fn(),
}));
vi.mock("../services/workflow/core-tool-executor.js", () => mockCoreExecutor);

const COMPANY_ID = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b001";
const WORKFLOW_RUN_ID = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b002";

type Dispatcher = {
  listToolsForAgent: ReturnType<typeof vi.fn>;
  getTool: ReturnType<typeof vi.fn>;
  executeTool: ReturnType<typeof vi.fn>;
};

/** Dispatcher whose getTool resolves (plugin branch) or not (core branch). */
function makeDispatcher(tool: string | null, execute: Dispatcher["executeTool"]): Dispatcher {
  return {
    listToolsForAgent: vi.fn(),
    getTool: vi.fn(() => (tool === null ? undefined : { namespacedName: tool })),
    executeTool: execute,
  };
}

describe("plugin tool execution idempotency receipts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-exec-receipt-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: COMPANY_ID, name: "Tool Receipt Test Co" });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCoreExecutor.resolveRunStepEnv.mockResolvedValue({});
    mockCoreExecutor.executeCoreWorkflowTool.mockResolvedValue({
      status: 404,
      body: { error: "Tool not found" },
    });
    await db.delete(pluginToolExecutionReceipts);
  });

  function createApp(dispatcher: Dispatcher) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [COMPANY_ID],
        source: "session",
      } as never;
      next();
    });
    app.use(
      "/api",
      pluginRoutes(db, {} as never, undefined, undefined, { toolDispatcher: dispatcher } as never, undefined),
    );
    app.use(errorHandler);
    return app;
  }

  const post = (app: ReturnType<typeof createApp>, payload: Record<string, unknown>) =>
    request(app).post("/api/plugins/tools/execute").send(payload);

  const runContext = { agentId: "agent-1", runId: "run-1", companyId: COMPANY_ID };
  const receiptRows = () => db.select().from(pluginToolExecutionReceipts);

  /** Pre-seed a receipt row for takeover/freshness tests. */
  const seedReceipt = (tool: string, key: string, values: Record<string, unknown>) =>
    db.insert(pluginToolExecutionReceipts).values({
      companyId: COMPANY_ID,
      runId: "run-1",
      tool,
      idempotencyKey: key,
      status: "executing",
      requestParameters: {},
      ...values,
    });

  it("(a) first call with a key executes and completes the receipt", async () => {
    const tool = "acme.linear:search-issues";
    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "ok", data: { n: 1 } }));
    const res = await post(createApp(dispatcher), {
      tool, parameters: { q: "x" }, runContext, idempotencyKey: "K-A",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content: "ok", data: { n: 1 } });
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].resultStatus).toBe(200);
    expect(rows[0].resultBody).toEqual({ content: "ok", data: { n: 1 } });
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].requestParameters).toEqual({ q: "x" });
  });

  it("(b) same key replays the stored body without re-execution", async () => {
    const tool = "acme.linear:get-issue";
    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "issue #7" }));
    const app = createApp(dispatcher);

    const first = await post(app, { tool, runContext, idempotencyKey: "K-B" });
    expect(first.status).toBe(200);

    const second = await post(app, { tool, runContext, idempotencyKey: "K-B" });
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);
    expect(await receiptRows()).toHaveLength(1);
  });

  it("(c) fresh executing receipt answers 409 without execution", async () => {
    const tool = "acme.linear:fresh-tool";
    await seedReceipt(tool, "K-C", { claimedAt: new Date() });

    const dispatcher = makeDispatcher(tool, vi.fn());
    const res = await post(createApp(dispatcher), { tool, runContext, idempotencyKey: "K-C" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Tool execution already in progress for this idempotency key");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("executing");
  });

  it("(d) executing receipt claimed 11 minutes ago is taken over and re-executed", async () => {
    const tool = "acme.linear:stale-tool";
    await seedReceipt(tool, "K-D", { claimedAt: new Date(Date.now() - 11 * 60 * 1000) });

    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "recovered" }));
    const res = await post(createApp(dispatcher), { tool, runContext, idempotencyKey: "K-D" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content: "recovered" });
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].resultStatus).toBe(200);
    expect(rows[0].completedAt).not.toBeNull();
  });

  it("(e) request without a key keeps legacy behavior and leaves no receipt rows", async () => {
    const tool = "acme.linear:no-key-tool";
    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "plain" }));
    const res = await post(createApp(dispatcher), { tool, runContext });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content: "plain" });
    expect(res.headers["x-idempotent-replay"]).toBeUndefined();
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);
    expect(await receiptRows()).toHaveLength(0);
  });

  it("(f) execution errors (502) are recorded and replayed without re-execution", async () => {
    const tool = "acme.linear:failing-tool";
    const dispatcher = makeDispatcher(tool, vi.fn().mockRejectedValue(new Error("worker not running")));
    const app = createApp(dispatcher);

    const first = await post(app, { tool, runContext, idempotencyKey: "K-F" });
    expect(first.status).toBe(502);
    expect(first.body.error).toBe("worker not running");

    const second = await post(app, { tool, runContext, idempotencyKey: "K-F" });
    expect(second.status).toBe(502);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(1);

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].resultStatus).toBe(502);
  });

  it("(g) core workflow tool path records and replays with workflow trace fields", async () => {
    const tool = "daily-tech-scout";
    mockCoreExecutor.resolveRunStepEnv.mockResolvedValue({
      PAPERCLIP_WORKFLOW_RUN_ID: WORKFLOW_RUN_ID,
      PAPERCLIP_WORKFLOW_STEP_ID: "step-9",
    });
    mockCoreExecutor.executeCoreWorkflowTool.mockResolvedValue({
      status: 200,
      body: { content: "core-ok", source: "core" },
    });
    const app = createApp(makeDispatcher(null, vi.fn()));

    const first = await post(app, { tool, runContext, idempotencyKey: "K-G" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ content: "core-ok", source: "core" });
    expect(mockCoreExecutor.executeCoreWorkflowTool).toHaveBeenCalledTimes(1);

    const second = await post(app, { tool, runContext, idempotencyKey: "K-G" });
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(mockCoreExecutor.executeCoreWorkflowTool).toHaveBeenCalledTimes(1);

    const [row] = await receiptRows();
    expect(row.status).toBe("completed");
    expect(row.resultStatus).toBe(200);
    expect(row.workflowRunId).toBe(WORKFLOW_RUN_ID);
    expect(row.stepId).toBe("step-9");
  });

  it("(h) invalid keys (non-string / empty / blank / 201 chars) answer 400 with no execution", async () => {
    const tool = "acme.linear:guarded-tool";
    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "ok" }));
    const app = createApp(dispatcher);

    for (const badKey of [123, "", "   ", "x".repeat(201)]) {
      const res = await post(app, { tool, runContext, idempotencyKey: badKey });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("idempotencyKey");
    }
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
    expect(await receiptRows()).toHaveLength(0);
  });

  it("(i) 404 tool-not-found leaves no row; the same key stays usable for a registered tool", async () => {
    const ghost = "ghost.plugin:missing";
    const notFound = await post(
      createApp(makeDispatcher(null, vi.fn())),
      { tool: ghost, runContext, idempotencyKey: "K-I" },
    );
    expect(notFound.status).toBe(404);
    expect(await receiptRows()).toHaveLength(0);

    const real = "acme.linear:later-tool";
    const realDispatcher = makeDispatcher(real, vi.fn().mockResolvedValue({ content: "now runs" }));
    const ok = await post(createApp(realDispatcher), { tool: real, runContext, idempotencyKey: "K-I" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ content: "now runs" });
    expect(realDispatcher.executeTool).toHaveBeenCalledTimes(1);
    expect(await receiptRows()).toHaveLength(1);
  });

  it("replays stay scoped: another run with the same key is a fresh execution", async () => {
    const tool = "acme.linear:scope-tool";
    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "scoped" }));
    const app = createApp(dispatcher);

    const first = await post(app, {
      tool, runContext: { ...runContext, runId: "run-1" }, idempotencyKey: "K-SCOPE",
    });
    expect(first.status).toBe(200);

    const otherRun = await post(app, {
      tool, runContext: { ...runContext, runId: "run-2" }, idempotencyKey: "K-SCOPE",
    });
    expect(otherRun.status).toBe(200);
    expect(otherRun.headers["x-idempotent-replay"]).toBeUndefined();
    expect(dispatcher.executeTool).toHaveBeenCalledTimes(2);
    expect(await receiptRows()).toHaveLength(2);
  });

  it("a completed receipt is replayed even when its claimed_at is old (no takeover)", async () => {
    const tool = "acme.linear:completed-tool";
    const old = new Date(Date.now() - 30 * 60 * 1000);
    await seedReceipt(tool, "K-DONE", {
      status: "completed",
      resultStatus: 200,
      resultBody: { content: "recorded" },
      claimedAt: old,
      completedAt: old,
    });

    const dispatcher = makeDispatcher(tool, vi.fn().mockResolvedValue({ content: "would re-run" }));
    const res = await post(createApp(dispatcher), { tool, runContext, idempotencyKey: "K-DONE" });
    expect(res.status).toBe(200);
    expect(res.headers["x-idempotent-replay"]).toBe("true");
    expect(res.body).toEqual({ content: "recorded" });
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });
});
