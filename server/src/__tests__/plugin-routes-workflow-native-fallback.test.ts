import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
}));

const mockWorkflowService = vi.hoisted(() => ({
  createDefinition: vi.fn(),
  listDefinitions: vi.fn(),
  listRuns: vi.fn(),
  trigger: vi.fn(),
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

vi.mock("../services/workflow/engine.js", () => ({
  workflowService: mockWorkflowService,
}));

const workflowPlugin = {
  id: "plugin-1",
  pluginKey: "insightflo.workflow-engine",
  packageName: "@insightflo/workflow-engine",
  version: "1.0.0",
  apiVersion: 1,
  categories: [],
  manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
  status: "ready",
  installOrder: 1,
  packagePath: null,
  lastError: null,
  installedAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-01T00:00:00.000Z"),
};

function createApp(workerManager: { call: ReturnType<typeof vi.fn> }) {
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
      undefined,
      { workerManager: workerManager as never },
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("workflow-engine plugin native workflow fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(workflowPlugin);
    mockRegistry.getByKey.mockResolvedValue(workflowPlugin);
    mockWorkflowService.listDefinitions.mockResolvedValue([]);
    mockWorkflowService.listRuns.mockResolvedValue([]);
  });

  it("merges native definitions and runs into workflow overview", async () => {
    const workerManager = {
      call: vi.fn().mockResolvedValue({
        workflows: [{ id: "plugin-workflow-1", name: "Plugin workflow" }],
        activeRuns: [{ id: "plugin-run-active", workflowName: "Plugin active", status: "running" }],
        recentRuns: [{ id: "plugin-run-recent", workflowName: "Plugin recent", status: "completed" }],
      }),
    };
    mockWorkflowService.listDefinitions.mockResolvedValue([
      {
        id: "workflow-1",
        companyId: "company-1",
        name: "Native workflow",
        steps: [
          {
            id: "step-1",
            name: "Run tool",
            description: "tool step",
            agentId: null,
            toolNames: ["paperclip.echo"],
            dependencies: [],
            knowledgeBaseIds: [],
          },
        ],
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-21T00:00:00.000Z"),
      },
    ]);
    mockWorkflowService.listRuns.mockResolvedValue([
      {
        id: "run-active-1",
        workflowId: "workflow-1",
        companyId: "company-1",
        missionId: "mission-1",
        status: "running",
        triggeredBy: "manual",
        startedAt: new Date("2026-04-22T00:00:00.000Z"),
        completedAt: null,
        createdAt: new Date("2026-04-22T00:00:00.000Z"),
      },
      {
        id: "run-recent-1",
        workflowId: "workflow-1",
        companyId: "company-1",
        missionId: "mission-1",
        status: "completed",
        triggeredBy: "scheduler",
        startedAt: new Date("2026-04-23T00:00:00.000Z"),
        completedAt: new Date("2026-04-23T00:10:00.000Z"),
        createdAt: new Date("2026-04-23T00:00:00.000Z"),
      },
    ]);

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/data/workflow-overview")
      .send({ params: { companyId: "company-1" } });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.listDefinitions).toHaveBeenCalledWith(expect.anything(), "company-1");
    expect(mockWorkflowService.listRuns).toHaveBeenCalledWith(expect.anything(), { companyId: "company-1" });
    expect(res.body.data.workflows).toEqual([
      expect.objectContaining({
        id: "workflow-1",
        companyId: "company-1",
        name: "Native workflow",
        status: "active",
        steps: [
          {
            id: "step-1",
            title: "Run tool",
            description: "tool step",
            type: "tool",
            toolName: "paperclip.echo",
            agentName: null,
            dependsOn: [],
          },
        ],
      }),
      { id: "plugin-workflow-1", name: "Plugin workflow" },
    ]);
    expect(res.body.data.activeRuns).toEqual([
      {
        id: "run-active-1",
        workflowName: "Native workflow",
        status: "running",
        startedAt: "2026-04-22T00:00:00.000Z",
        triggerSource: "manual",
      },
      { id: "plugin-run-active", workflowName: "Plugin active", status: "running" },
    ]);
    expect(res.body.data.recentRuns).toEqual([
      {
        id: "run-recent-1",
        workflowName: "Native workflow",
        status: "completed",
        startedAt: "2026-04-23T00:00:00.000Z",
        completedAt: "2026-04-23T00:10:00.000Z",
        triggerSource: "scheduler",
      },
      { id: "plugin-run-recent", workflowName: "Plugin recent", status: "completed" },
    ]);
  });

  it("falls back to native workflow trigger when start-workflow handler is missing", async () => {
    const workerManager = {
      call: vi.fn().mockRejectedValue(
        new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
          message: "No action handler registered for start-workflow",
        }),
      ),
    };
    mockWorkflowService.trigger.mockResolvedValue({
      runId: "run-1",
      status: "running",
      completedAt: new Date("2026-04-26T00:00:00.000Z"),
      stepRuns: [],
    });

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/start-workflow")
      .send({
        companyId: "company-1",
        workflowId: "workflow-1",
        missionId: "mission-1",
        triggerSource: "manual",
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.trigger).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      workflowId: "workflow-1",
      missionId: "mission-1",
      triggeredBy: "manual",
    });
    expect(res.body).toEqual({
      data: {
        run: {
          runId: "run-1",
          status: "running",
          completedAt: "2026-04-26T00:00:00.000Z",
          stepRuns: [],
        },
        runId: "run-1",
        status: "running",
        completedAt: "2026-04-26T00:00:00.000Z",
        stepRuns: [],
      },
    });
  });

  it("falls back to native workflow trigger when the worker cannot find a native workflow", async () => {
    const workerManager = {
      call: vi.fn().mockRejectedValue(
        new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
          message: "Workflow definition not found: workflow-1",
        }),
      ),
    };
    mockWorkflowService.trigger.mockResolvedValue({
      runId: "run-native-1",
      status: "running",
      completedAt: new Date("2026-04-26T01:00:00.000Z"),
      stepRuns: [],
    });

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/start-workflow")
      .send({
        companyId: "company-1",
        workflowId: "workflow-1",
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.trigger).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      workflowId: "workflow-1",
      missionId: undefined,
      triggeredBy: "board",
    });
    expect(res.body.data.runId).toBe("run-native-1");
  });
});
