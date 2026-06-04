import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function createApp(toolDispatcher: {
  listToolsForAgent: ReturnType<typeof vi.fn>;
  getTool: ReturnType<typeof vi.fn>;
  executeTool: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: ["company-1"],
      source: "session",
    };
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      {} as never,
      undefined,
      undefined,
      { toolDispatcher: toolDispatcher as never },
      undefined,
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("plugin tool execution projectless run context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes agent tools when a projectless mission run has no projectId", async () => {
    const toolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn().mockReturnValue({ namespacedName: "insightflo.research-workbench:research-search" }),
      executeTool: vi.fn().mockResolvedValue({
        content: "ok",
        data: { rawEngine: { name: "vane-headless" } },
      }),
    };

    const runContext = {
      agentId: "agent-1",
      runId: "run-1",
      companyId: "company-1",
    };

    const res = await request(createApp(toolDispatcher))
      .post("/api/plugins/tools/execute")
      .send({
        tool: "insightflo.research-workbench:research-search",
        parameters: { topic: "Oklo SMR" },
        runContext,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.rawEngine.name).toBe("vane-headless");
    expect(toolDispatcher.executeTool).toHaveBeenCalledWith(
      "insightflo.research-workbench:research-search",
      { topic: "Oklo SMR" },
      runContext,
    );
  });

  it("still requires agentId, runId, and companyId", async () => {
    const toolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn().mockReturnValue({ namespacedName: "insightflo.research-workbench:research-search" }),
      executeTool: vi.fn(),
    };

    const res = await request(createApp(toolDispatcher))
      .post("/api/plugins/tools/execute")
      .send({
        tool: "insightflo.research-workbench:research-search",
        parameters: { topic: "Oklo SMR" },
        runContext: { agentId: "agent-1", companyId: "company-1" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"runContext" must include agentId, runId, and companyId');
    expect(toolDispatcher.executeTool).not.toHaveBeenCalled();
  });
});
