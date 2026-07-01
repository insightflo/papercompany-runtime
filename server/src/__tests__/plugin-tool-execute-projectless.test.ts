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
}, options: {
  actor?: Record<string, unknown>;
  dbRows?: unknown[];
  dbRowQueue?: unknown[][];
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (options.actor ?? {
      type: "board",
      userId: "board-user-1",
      companyIds: ["company-1"],
      source: "session",
    }) as never;
    next();
  });
  const rowQueue = [...(options.dbRowQueue ?? [])];
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(rowQueue.length > 0 ? rowQueue.shift() : (options.dbRows ?? []))),
  };
  const db = {
    select: vi.fn(() => query),
  };
  app.use(
    "/api",
    pluginRoutes(
      db as never,
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

  it("allows an agent to execute a workflow tool allowed by its current run contract", async () => {
    const toolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn().mockReturnValue({ namespacedName: "daily-tech-scout" }),
      executeTool: vi.fn().mockResolvedValue({ content: "ok" }),
    };
    const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1" };

    const res = await request(createApp(toolDispatcher, {
      actor: { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" },
      dbRows: [{
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        contextSnapshot: {
          paperclipWorkflowStepToolContract: {
            toolNames: ["daily-tech-scout"],
            tools: [{ name: "daily-tech-scout" }],
          },
        },
      }],
    }))
      .post("/api/plugins/tools/execute")
      .send({ tool: "daily-tech-scout", parameters: { limit: 25 }, runContext });

    expect(res.status).toBe(200);
    expect(toolDispatcher.executeTool).toHaveBeenCalledWith("daily-tech-scout", { limit: 25 }, runContext);
  });

  it("falls back to a granted core builtin workflow tool when no plugin tool is registered", async () => {
    const toolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn().mockReturnValue(null),
      executeTool: vi.fn(),
    };
    const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1" };

    const res = await request(createApp(toolDispatcher, {
      actor: { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" },
      dbRowQueue: [
        [{
          id: "run-1",
          agentId: "agent-1",
          companyId: "company-1",
          issueId: "issue-1",
          contextSnapshot: {
            paperclipWorkflowStepToolContract: {
              toolNames: ["daily-tech-scout"],
              tools: [{ name: "daily-tech-scout" }],
            },
          },
        }],
        [{
          id: "run-1",
          agentId: "agent-1",
          companyId: "company-1",
          issueId: null,
        }],
        [{
          id: "tool-1",
          name: "daily-tech-scout",
          enabled: true,
          adapterType: "builtin",
          adapterConfig: {
            command: "node -e 'console.log(JSON.stringify({ ok: true }))' --",
            workingDirectory: process.cwd(),
            env: {},
            requiresApproval: false,
          },
        }],
        [{ id: "grant-1" }],
      ],
    }))
      .post("/api/plugins/tools/execute")
      .send({ tool: "daily-tech-scout", parameters: { limit: 25 }, runContext });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("core");
    expect(res.body.data).toEqual({ ok: true });
    expect(toolDispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("rejects an agent executing a tool outside its workflow run contract", async () => {
    const toolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn().mockReturnValue({ namespacedName: "manual-publisher" }),
      executeTool: vi.fn(),
    };

    const res = await request(createApp(toolDispatcher, {
      actor: { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" },
      dbRows: [{
        id: "run-1",
        agentId: "agent-1",
        companyId: "company-1",
        contextSnapshot: {
          paperclipWorkflowStepToolContract: {
            toolNames: ["daily-tech-scout"],
          },
        },
      }],
    }))
      .post("/api/plugins/tools/execute")
      .send({
        tool: "manual-publisher",
        parameters: {},
        runContext: { agentId: "agent-1", runId: "run-1", companyId: "company-1" },
      });

    expect(res.status).toBe(403);
    expect(toolDispatcher.executeTool).not.toHaveBeenCalled();
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
