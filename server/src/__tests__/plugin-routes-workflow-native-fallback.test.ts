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
  cancelRun: vi.fn(),
  createDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  getDefinition: vi.fn(),
  getRun: vi.fn(),
  listDefinitions: vi.fn(),
  listRuns: vi.fn(),
  listStepRuns: vi.fn(),
  resumeRun: vi.fn(),
  trigger: vi.fn(),
  updateDefinition: vi.fn(),
}));

const mockCompleteWorkflowToolStepFromResult = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
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

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/work-products.js", () => ({
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/workflow/dag-engine.js", () => ({
  completeWorkflowToolStepFromResult: mockCompleteWorkflowToolStepFromResult,
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

function pluginWithSidebarContribution(pluginKey: string, displayName: string, installOrder: number) {
  return {
    id: `${pluginKey}-plugin-id`,
    pluginKey,
    packageName: `@test/${pluginKey}`,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName,
      description: "Test plugin",
      author: "papercompany",
      categories: [],
      capabilities: [],
      entrypoints: {
        worker: "dist/worker.js",
        ui: "dist/ui",
      },
      ui: {
        slots: [
          {
            type: "sidebar",
            id: "sidebar-link",
            displayName,
            exportName: "SidebarLink",
          },
        ],
      },
    },
    status: "ready",
    installOrder,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
  };
}

function createApp(workerManager: { call: ReturnType<typeof vi.fn> }, db: unknown = {}) {
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
      db as never,
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
    mockWorkflowService.listStepRuns.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(null);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: "workflow-1",
      companyId: "company-1",
      name: "Native workflow",
      steps: [],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    });
    mockWorkflowService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      workflowId: "workflow-1",
      missionId: "mission-1",
      status: "running",
    });
  });

  it("omits core-integrated workflow and Tool Registry UI contributions", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      pluginWithSidebarContribution("insightflo.workflow-engine", "Workflow Engine", 1),
      pluginWithSidebarContribution("insightflo.tool-registry", "Tool Registry", 2),
      pluginWithSidebarContribution("acme.sidebar", "Acme Sidebar", 3),
    ]);

    const res = await request(createApp({ call: vi.fn() }))
      .get("/api/plugins/ui-contributions");

    expect(res.status).toBe(200);
    expect(res.body.map((item: { pluginKey: string }) => item.pluginKey)).toEqual([
      "acme.sidebar",
    ]);
    expect(res.body[0]).toMatchObject({
      pluginKey: "acme.sidebar",
      displayName: "Acme Sidebar",
      uiEntryFile: "index.js",
      slots: [
        expect.objectContaining({
          type: "sidebar",
          id: "sidebar-link",
        }),
      ],
    });
  });

  it("merges native definitions and uses native runs in workflow overview", async () => {
    const workerManager = {
      call: vi.fn().mockResolvedValue({
        workflows: [
          { id: "workflow-1", name: "Plugin workflow", status: "paused", description: "plugin metadata" },
          { id: "plugin-workflow-1", name: "Plugin only workflow" },
        ],
        activeRuns: [
          { id: "run-active-1", workflowName: "Plugin active", status: "running" },
          { id: "plugin-run-active", workflowName: "Plugin active only", status: "running" },
        ],
        recentRuns: [
          { id: "run-recent-1", workflowName: "Plugin recent", status: "completed" },
          { id: "plugin-run-recent", workflowName: "Plugin recent only", status: "completed" },
        ],
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
      {
        id: "workflow-2",
        companyId: "company-1",
        name: "Native only workflow",
        steps: [
          {
            id: "step-2",
            name: "Ask agent",
            description: null,
            agentId: "agent-1",
            toolNames: [],
            dependencies: ["step-1"],
            knowledgeBaseIds: [],
            graphPositionX: 320,
            graphPositionY: -48,
            graphEdgeMetadata: {
              "step-1": { kind: "success", label: "ready", condition: "ok" },
            },
          },
        ],
        createdAt: new Date("2026-04-24T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
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
      {
        id: "run-recent-2",
        workflowId: "workflow-2",
        companyId: "company-1",
        missionId: null,
        status: "completed",
        triggeredBy: "manual",
        startedAt: new Date("2026-04-26T00:00:00.000Z"),
        completedAt: new Date("2026-04-26T00:10:00.000Z"),
        createdAt: new Date("2026-04-26T00:00:00.000Z"),
      },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ id: "agent-1", name: "Researcher" }]),
        })),
      })),
    };

    const res = await request(createApp(workerManager, db))
      .post("/api/plugins/plugin-1/data/workflow-overview")
      .send({ params: { companyId: "company-1" } });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.listDefinitions).toHaveBeenCalledWith(expect.anything(), "company-1");
    expect(mockWorkflowService.listRuns).toHaveBeenCalledWith(expect.anything(), { companyId: "company-1" });
    expect(res.body.data.workflows).toEqual([
      { id: "workflow-1", name: "Plugin workflow", status: "paused", description: "plugin metadata" },
      { id: "plugin-workflow-1", name: "Plugin only workflow" },
      expect.objectContaining({
        id: "workflow-2",
        companyId: "company-1",
        name: "Native only workflow",
        status: "active",
        steps: [
          expect.objectContaining({
            id: "step-2",
            title: "Ask agent",
            description: "",
            type: "agent",
            toolName: "",
            agentName: "Researcher",
            dependsOn: ["step-1"],
            dependencies: ["step-1"],
            graphPositionX: 320,
            graphPositionY: -48,
            graphEdgeMetadata: {
              "step-1": { kind: "success", label: "ready", condition: "ok" },
            },
          }),
        ],
      }),
    ]);
    expect(res.body.data.workflows.map((workflow: { id: string }) => workflow.id)).toEqual([
      "workflow-1",
      "plugin-workflow-1",
      "workflow-2",
    ]);
    expect(res.body.data.activeRuns).toEqual([
      {
        id: "run-active-1",
        workflowName: "Native workflow",
        status: "running",
        startedAt: "2026-04-22T00:00:00.000Z",
        triggerSource: "manual",
      },
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
      {
        id: "run-recent-2",
        workflowName: "Native only workflow",
        status: "completed",
        startedAt: "2026-04-26T00:00:00.000Z",
        completedAt: "2026-04-26T00:10:00.000Z",
        triggerSource: "manual",
      },
    ]);
  });

  it("returns native workflow run detail when overview run ids come from native workflow storage", async () => {
    const workerManager = {
      call: vi.fn().mockResolvedValue(null),
    };
    mockWorkflowService.getRun.mockResolvedValue({
      id: "native-run-1",
      workflowId: "workflow-1",
      companyId: "company-1",
      missionId: "mission-1",
      status: "completed",
      triggeredBy: "manual",
      triggerSource: "manual",
      runLabel: "2026-04-26 #1",
      parentIssueId: null,
      startedAt: new Date("2026-04-26T00:00:00.000Z"),
      completedAt: new Date("2026-04-26T00:10:00.000Z"),
      createdAt: new Date("2026-04-26T00:00:00.000Z"),
    });
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: "workflow-1",
      companyId: "company-1",
      name: "Native workflow",
      description: "native detail",
      status: "active",
      executionMode: "static_dag",
      steps: [
        {
          id: "collect",
          name: "Collect signals",
          description: "collect",
          agentId: "agent-1",
          toolNames: [],
          dependencies: [],
        },
        {
          id: "summarize",
          name: "Summarize",
          description: null,
          agentId: null,
          toolNames: ["paperclip.echo"],
          dependencies: ["collect"],
        },
      ],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    });
    const issueId = "00000000-0000-4000-8000-000000000001";
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId: "company-1",
      identifier: "CMPA-123",
    });
    mockWorkProductService.listForIssue.mockResolvedValue([
      {
        id: "work-product-1",
        companyId: "company-1",
        projectId: null,
        issueId,
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "document",
        provider: "paperclip",
        externalId: null,
        title: "Signals brief",
        url: "http://127.0.0.1:3200/artifacts/signals.html",
        status: "ready_for_review",
        reviewState: "none",
        isPrimary: true,
        healthStatus: "healthy",
        summary: "Generated market signal brief.",
        metadata: { path: "/tmp/signals.html" },
        createdByRunId: null,
        createdAt: new Date("2026-04-26T00:04:00.000Z"),
        updatedAt: new Date("2026-04-26T00:04:30.000Z"),
      },
    ]);
    mockWorkflowService.listStepRuns.mockResolvedValue([
      {
        id: "step-run-1",
        workflowRunId: "native-run-1",
        stepId: "collect",
        issueId,
        status: "completed",
        agentName: "Researcher",
        retryCount: 0,
        sessionId: null,
        lastDispatchAttemptAt: new Date("2026-04-26T00:01:00.000Z"),
        lastDispatchAcceptedAt: new Date("2026-04-26T00:02:00.000Z"),
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        lastDispatchRequestId: null,
        metadata: {},
        startedAt: new Date("2026-04-26T00:02:00.000Z"),
        completedAt: new Date("2026-04-26T00:05:00.000Z"),
      },
    ]);

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/data/workflow-run-detail")
      .send({ params: { runId: "native-run-1" } });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.getRun).toHaveBeenCalledWith(expect.anything(), "native-run-1");
    expect(mockWorkflowService.getDefinition).toHaveBeenCalledWith(expect.anything(), "workflow-1");
    expect(mockWorkflowService.listStepRuns).toHaveBeenCalledWith(expect.anything(), "native-run-1");
    expect(mockWorkProductService.listForIssue).toHaveBeenCalledWith(issueId);
    expect(res.body.data).toEqual(expect.objectContaining({
      run: expect.objectContaining({
        id: "native-run-1",
        workflowId: "workflow-1",
        status: "completed",
        startedAt: "2026-04-26T00:00:00.000Z",
        completedAt: "2026-04-26T00:10:00.000Z",
      }),
      workflow: expect.objectContaining({
        id: "workflow-1",
        name: "Native workflow",
        steps: [
          expect.objectContaining({
            id: "collect",
            title: "Collect signals",
            type: "agent",
            dependsOn: [],
          }),
          expect.objectContaining({
            id: "summarize",
            title: "Summarize",
            type: "tool",
            toolName: "paperclip.echo",
            dependsOn: ["collect"],
          }),
        ],
      }),
      stepRuns: [
        expect.objectContaining({
          id: "step-run-1",
          stepId: "collect",
          stepTitle: "Collect signals",
          stepType: "agent",
          issueId,
          issueIdentifier: "CMPA-123",
          status: "completed",
          agentName: "Researcher",
          completedAt: "2026-04-26T00:05:00.000Z",
          workProducts: [
            expect.objectContaining({
              id: "work-product-1",
              title: "Signals brief",
              type: "document",
              url: "http://127.0.0.1:3200/artifacts/signals.html",
              status: "ready_for_review",
              summary: "Generated market signal brief.",
            }),
          ],
        }),
      ],
    }));
  });

  it("routes start-workflow to native DAG without calling the plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
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
    expect(workerManager.call).not.toHaveBeenCalled();
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

  it("routes tool execution results to native workflow state without calling the workflow-engine plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    mockCompleteWorkflowToolStepFromResult.mockResolvedValue({
      runId: "run-1",
      workflowId: "workflow-1",
      missionId: null,
      status: "completed",
      completedAt: new Date("2026-04-26T03:00:00.000Z"),
      stepRuns: [
        { id: "step-run-1", workflowRunId: "run-1", stepId: "fetch", issueId: null, status: "completed" },
      ],
    });

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/handle-tool-execution-result")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          requestId: "run-1:fetch:1",
          workflowRunId: "run-1",
          stepRunId: "step-run-1",
          stepId: "fetch",
          toolName: "paperclip.echo",
          success: true,
          stdout: "ok",
          stderr: "",
          exitCode: 0,
        },
      });

    expect(res.status).toBe(200);
    expect(mockCompleteWorkflowToolStepFromResult).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      requestId: "run-1:fetch:1",
      workflowRunId: "run-1",
      stepRunId: "step-run-1",
      stepId: "fetch",
      toolName: "paperclip.echo",
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      error: undefined,
    });
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.data).toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ runId: "run-1", status: "completed" }),
    }));
  });

  it("clears stale plugin schedule errors after native start-workflow succeeds", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    const whereSelect = vi.fn().mockResolvedValue([
      {
        id: "workflow-1",
        status: "active",
        data: {
          id: "workflow-1",
          companyId: "company-1",
          name: "scheduled workflow",
          status: "active",
          lastScheduleError: "Workflow run not found: native-run-1",
          lastScheduleErrorAt: "2026-06-10T01:00:00.000Z",
        },
      },
    ]);
    const from = vi.fn(() => ({ where: whereSelect }));
    const select = vi.fn(() => ({ from }));
    const whereUpdate = vi.fn().mockResolvedValue([]);
    const set = vi.fn(() => ({ where: whereUpdate }));
    const update = vi.fn(() => ({ set }));
    const db = { select, update };
    mockWorkflowService.trigger.mockResolvedValue({
      runId: "native-run-1",
      status: "completed",
      stepRuns: [],
    });

    const res = await request(createApp(workerManager, db))
      .post("/api/plugins/plugin-1/actions/start-workflow")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          workflowId: "workflow-1",
          triggerSource: "schedule",
        },
      });

    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({
        lastScheduleError: expect.anything(),
        lastScheduleErrorAt: expect.anything(),
      }),
      updatedAt: expect.any(Date),
    }));
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("refreshes stale native workflow definition from plugin entity data before start-workflow", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    const pluginSteps = [
      {
        id: "collect-ai-news-evidence",
        title: "Collect bounded TechCrunch AI evidence",
        agentName: "Technology Research Agent",
        dependsOn: [],
      },
      {
        id: "synthesize-ai-news-note",
        title: "Synthesize TechCrunch AI note draft",
        agentName: "Synthesis Editor",
        dependsOn: ["collect-ai-news-evidence"],
      },
    ];
    const where = vi.fn().mockResolvedValue([
      {
        id: "plugin-entity-1",
        data: {
          id: "workflow-1",
          companyId: "company-1",
          name: "tech-ai-news",
          executionMode: "static_dag",
          steps: pluginSteps,
        },
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select };
    mockWorkflowService.trigger.mockResolvedValue({
      runId: "run-refreshed-1",
      status: "running",
      stepRuns: [],
    });

    const res = await request(createApp(workerManager, db))
      .post("/api/plugins/plugin-1/actions/start-workflow")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          workflowId: "workflow-1",
          triggerSource: "manual-test",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.getDefinition).toHaveBeenCalledWith(db, "workflow-1");
    expect(mockWorkflowService.updateDefinition).toHaveBeenCalledWith(db, "workflow-1", {
      name: "tech-ai-news",
      executionMode: "static_dag",
      steps: pluginSteps,
    });
    expect(mockWorkflowService.trigger).toHaveBeenCalledWith(db, {
      companyId: "company-1",
      workflowId: "workflow-1",
      missionId: undefined,
      triggeredBy: "manual-test",
    });
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.data.runId).toBe("run-refreshed-1");
  });

  it("persists update-workflow status changes to plugin workflow entity data", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    const whereSelect = vi.fn().mockResolvedValue([
      {
        id: "workflow-1",
        status: "active",
        data: {
          id: "workflow-1",
          companyId: "company-1",
          name: "pausable workflow",
          status: "active",
          schedule: "* * * * *",
        },
      },
    ]);
    const from = vi.fn(() => ({ where: whereSelect }));
    const select = vi.fn(() => ({ from }));
    const whereUpdate = vi.fn().mockResolvedValue([]);
    const set = vi.fn(() => ({ where: whereUpdate }));
    const update = vi.fn(() => ({ set }));
    const db = { select, update };

    const res = await request(createApp(workerManager, db))
      .post("/api/plugins/plugin-1/actions/update-workflow")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          workflowId: "workflow-1",
          patch: { status: "paused" },
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.updateDefinition).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: "paused",
      data: expect.objectContaining({
        id: "workflow-1",
        status: "paused",
        schedule: "* * * * *",
      }),
      updatedAt: expect.any(Date),
    }));
    expect(res.body.data.status).toBe("paused");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("routes delete-workflow to native definition management without calling the plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    mockWorkflowService.deleteDefinition.mockResolvedValue(true);

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/delete-workflow")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          workflowId: "workflow-1",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.getDefinition).toHaveBeenCalledWith(expect.anything(), "workflow-1");
    expect(mockWorkflowService.deleteDefinition).toHaveBeenCalledWith(expect.anything(), "workflow-1");
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      data: {
        id: "workflow-1",
        status: "archived",
        deleted: true,
      },
    });
  });

  it("routes top-level start-workflow params through native DAG", async () => {
    const workerManager = {
      call: vi.fn(),
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
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.data.runId).toBe("run-native-1");
  });

  it("routes resume-run to native workflow sync without calling the plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    mockWorkflowService.resumeRun.mockResolvedValue({
      runId: "run-1",
      status: "running",
      completedAt: new Date("2026-04-26T02:00:00.000Z"),
      stepRuns: [],
    });

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/resume-run")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          runId: "run-1",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.resumeRun).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      runId: "run-1",
    });
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.data.runId).toBe("run-1");
  });

  it("rejects resume-run for legacy plugin runs instead of falling back to the plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    mockWorkflowService.getRun.mockResolvedValue(null);

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/resume-run")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          runId: "legacy-plugin-run-1",
        },
      });

    expect(res.status).toBe(404);
    expect(mockWorkflowService.resumeRun).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.message).toContain("Legacy plugin workflow-run execution is disabled");
  });

  it("routes cancel-run to native workflow cancellation without calling the plugin worker", async () => {
    const workerManager = {
      call: vi.fn(),
    };
    mockWorkflowService.cancelRun.mockResolvedValue(true);

    const res = await request(createApp(workerManager))
      .post("/api/plugins/plugin-1/actions/cancel-run")
      .send({
        companyId: "company-1",
        params: {
          companyId: "company-1",
          runId: "run-1",
        },
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.getRun).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(mockWorkflowService.cancelRun).toHaveBeenCalledWith(expect.anything(), { runId: "run-1", companyId: "company-1" });
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({
      id: "run-1",
      runId: "run-1",
      status: "cancelled",
      cancelled: true,
    });
  });
});
