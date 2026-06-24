import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { logActivity } from "../services/activity-log.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_ISSUE_ID = "66666666-6666-4666-8666-666666666666";

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
  syncRunStatusForIssue: vi.fn(),
  trigger: vi.fn(),
  updateDefinition: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockWorkflowToolCatalog = vi.hoisted(() => ({
  grantWorkflowToolToAgent: vi.fn(),
  listWorkflowToolCatalog: vi.fn(),
  revokeWorkflowToolFromAgent: vi.fn(),
  syncToolRegistryToolsToCore: vi.fn(),
}));

const mockWorkProductsService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

vi.mock("../services/workflow/engine.js", () => ({
  workflowService: mockWorkflowService,
}));

vi.mock("../services/workflow/tool-catalog.js", () => mockWorkflowToolCatalog);

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/work-products.js", () => ({
  workProductService: () => mockWorkProductsService,
}));

function workflowDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    companyId: COMPANY_ID,
    name: "Daily ops",
    description: "Operate the company",
    status: "active",
    steps: [
      {
        id: "step-1",
        name: "Research",
        title: "Research",
        agentId: "77777777-7777-4777-8777-777777777777",
        assigneeAgentId: "88888888-8888-4888-8888-888888888888",
        dependencies: [],
        legacyPassthrough: true,
      },
    ],
    schedule: "0 9 * * *",
    timezone: "Asia/Seoul",
    deadlineTime: "17:00",
    timeoutMinutes: 60,
    maxDailyRuns: 1,
    maxConcurrentRuns: 1,
    triggerLabels: ["ops"],
    labelIds: ["label-1"],
    projectId: null,
    goalId: null,
    createParentIssuePolicy: "per_run",
    executionMode: "static_dag",
    dynamicPlanBootstrapOnly: false,
    source: "native",
    sourceKind: "workflow",
    legacyPluginEntityId: null,
    legacyMetadata: { imported: false },
    createdAt: new Date("2026-06-11T00:00:00.000Z"),
    updatedAt: new Date("2026-06-11T01:00:00.000Z"),
    ...overrides,
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    companyId: COMPANY_ID,
    missionId: null,
    status: "running",
    originalStatus: null,
    triggeredBy: "board",
    triggerSource: "api",
    runDate: "2026-06-11",
    runNumber: 3,
    runLabel: "2026-06-11 #3",
    parentIssueId: PARENT_ISSUE_ID,
    scheduledSlotId: null,
    legacyPluginRunEntityId: null,
    metadata: { source: "test" },
    startedAt: new Date("2026-06-11T02:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-06-11T01:59:00.000Z"),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user-1",
  companyIds: [COMPANY_ID],
  source: "authenticated",
  isInstanceAdmin: false,
}, db: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", workflowRoutes(db as never));
  app.use(errorHandler);
  return app;
}

describe("workflow routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWorkflowService.getDefinition.mockResolvedValue(workflowDefinition());
    mockWorkflowService.getRun.mockResolvedValue(workflowRun());
    mockWorkflowService.listStepRuns.mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-999999999999",
        workflowRunId: RUN_ID,
        stepId: "step-1",
        issueId: ISSUE_ID,
        status: "running",
        originalStatus: "in_progress",
        agentName: "Researcher",
        retryCount: 2,
        sessionId: "session-1",
        lastDispatchAttemptAt: new Date("2026-06-11T02:01:00.000Z"),
        lastDispatchAcceptedAt: new Date("2026-06-11T02:02:00.000Z"),
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        lastDispatchRequestId: "dispatch-1",
        legacyPluginStepEntityId: null,
        metadata: { dispatch: "ok" },
        startedAt: new Date("2026-06-11T02:03:00.000Z"),
        completedAt: null,
      },
    ]);
    mockWorkflowToolCatalog.listWorkflowToolCatalog.mockResolvedValue({
      tools: [],
      grants: [],
      sources: {
        core: { available: true, count: 0 },
        toolRegistry: { available: false, installed: false, count: 0 },
      },
    });
    mockWorkProductsService.listForIssue.mockResolvedValue([]);
  });

  it("resolves agentId-only workflow steps to agent names in the overview", async () => {
    const agentId = "77777777-7777-4777-8777-777777777777";
    const dbResponses: unknown[][] = [
      [],
      [],
      [{ id: agentId, name: "Technology Research Agent" }],
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => dbResponses.shift() ?? []),
        })),
      })),
    };
    mockWorkflowService.listDefinitions.mockResolvedValue([
      workflowDefinition({
        steps: [
          {
            id: "collect-tech-scout-evidence",
            name: "Collect tech scout evidence",
            type: "agent",
            agentId,
            toolNames: ["daily-tech-scout"],
            dependencies: [],
          },
        ],
      }),
    ]);
    mockWorkflowService.listRuns.mockResolvedValue([]);

    const res = await request(createApp(undefined, db)).get(`/api/companies/${COMPANY_ID}/workflows/overview`);

    expect(res.status).toBe(200);
    expect(res.body.workflows[0].steps[0]).toEqual(expect.objectContaining({
      id: "collect-tech-scout-evidence",
      agentName: "Technology Research Agent",
      toolNames: ["daily-tech-scout"],
    }));
  });

  it("lists workflow tools from the core workflow tool catalog", async () => {
    mockWorkflowToolCatalog.listWorkflowToolCatalog.mockResolvedValue({
      tools: [
        {
          name: "collect-evening",
          displayName: "collect-evening",
          description: "Collect evening inputs",
          source: "tool-registry",
          enabled: true,
        },
        {
          name: "core-report",
          displayName: "core-report",
          description: "Core report tool",
          source: "core",
          enabled: true,
        },
      ],
      grants: [{ agentName: "도라에몽", toolName: "collect-evening" }],
      sources: {
        core: { available: true, count: 1 },
        toolRegistry: { available: true, installed: true, count: 1 },
      },
    });

    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/workflows/tools`);

    expect(res.status).toBe(200);
    expect(mockWorkflowToolCatalog.listWorkflowToolCatalog).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);
    expect(res.body).toEqual({
      tools: [
        {
          name: "collect-evening",
          displayName: "collect-evening",
          description: "Collect evening inputs",
          source: "tool-registry",
          enabled: true,
        },
        {
          name: "core-report",
          displayName: "core-report",
          description: "Core report tool",
          source: "core",
          enabled: true,
        },
      ],
      grants: [{ agentName: "도라에몽", toolName: "collect-evening" }],
      sources: {
        core: { available: true, count: 1 },
        toolRegistry: { available: true, installed: true, count: 1 },
      },
    });
  });

  it("does not expose workflow tools across company boundaries", async () => {
    const res = await request(createApp()).get(`/api/companies/${OTHER_COMPANY_ID}/workflows/tools`);

    expect(res.status).toBe(403);
    expect(mockWorkflowToolCatalog.listWorkflowToolCatalog).not.toHaveBeenCalled();
  });

  it("grants and revokes core workflow tools through company-scoped routes", async () => {
    mockWorkflowToolCatalog.grantWorkflowToolToAgent.mockResolvedValue({
      agentName: "Doraemon",
      toolName: "collect-evening",
      source: "core",
    });
    mockWorkflowToolCatalog.revokeWorkflowToolFromAgent.mockResolvedValue(true);

    const grant = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows/tools/grants`)
      .send({
        agentId: "77777777-7777-4777-8777-777777777777",
        toolName: "collect-evening",
      });

    expect(grant.status).toBe(201);
    expect(grant.body).toEqual({
      agentName: "Doraemon",
      toolName: "collect-evening",
      source: "core",
    });
    expect(mockWorkflowToolCatalog.grantWorkflowToolToAgent).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      agentId: "77777777-7777-4777-8777-777777777777",
      toolName: "collect-evening",
      grantedBy: "board-user-1",
    });

    const revoke = await request(createApp())
      .delete(`/api/companies/${COMPANY_ID}/workflows/tools/grants`)
      .send({
        agentId: "77777777-7777-4777-8777-777777777777",
        toolName: "collect-evening",
      });

    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ revoked: true });
    expect(mockWorkflowToolCatalog.revokeWorkflowToolFromAgent).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      agentId: "77777777-7777-4777-8777-777777777777",
      toolName: "collect-evening",
    });
  });

  it("syncs tool-registry workflow tools into core records through a company-scoped route", async () => {
    mockWorkflowToolCatalog.syncToolRegistryToolsToCore.mockResolvedValue({
      createdTools: 2,
      updatedTools: 1,
      createdGrants: 3,
      skippedGrants: 4,
    });

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows/tools/sync-from-tool-registry`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      createdTools: 2,
      updatedTools: 1,
      createdGrants: 3,
      skippedGrants: 4,
    });
    expect(mockWorkflowToolCatalog.syncToolRegistryToolsToCore).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);
  });

  it("creates a workflow definition with Phase B fields and logs activity", async () => {
    mockWorkflowService.createDefinition.mockResolvedValue(workflowDefinition());

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows`)
      .send({
        name: "Daily ops",
        description: "Operate the company",
        status: "active",
        steps: [{ id: "step-1", title: "Research", agentId: "77777777-7777-4777-8777-777777777777", assigneeAgentId: "88888888-8888-4888-8888-888888888888", legacyPassthrough: true }],
        schedule: "0 9 * * *",
        timezone: "Asia/Seoul",
        deadlineTime: "17:00",
        triggerLabels: ["ops"],
        labelIds: ["label-1"],
        executionMode: "static_dag",
      });

    expect(res.status).toBe(201);
    expect(mockWorkflowService.createDefinition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: COMPANY_ID,
      name: "Daily ops",
      timezone: "Asia/Seoul",
      triggerLabels: ["ops"],
      labelIds: ["label-1"],
      steps: [expect.objectContaining({ id: "step-1", legacyPassthrough: true })],
    }));
    expect(res.body).toEqual(expect.objectContaining({
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      timezone: "Asia/Seoul",
      triggerLabels: ["ops"],
      legacyMetadata: { imported: false },
      createdAt: "2026-06-11T00:00:00.000Z",
    }));
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: COMPANY_ID,
      action: "workflow.created",
      entityType: "workflow",
      entityId: WORKFLOW_ID,
    }));
  });

  it("returns 422 for invalid DAG create errors", async () => {
    mockWorkflowService.createDefinition.mockRejectedValue(new Error("Invalid workflow DAG: Step review depends on unknown step missing"));

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows`)
      .send({
        name: "Broken workflow",
        steps: [
          { id: "review", title: "Review", agentId: "77777777-7777-4777-8777-777777777777", dependencies: ["missing"] },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid workflow DAG: Step review depends on unknown step missing");
    expect(logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workflow.created" }));
  });

  it("returns 422 for invalid DAG patch errors", async () => {
    mockWorkflowService.updateDefinition.mockRejectedValue(new Error("Invalid workflow DAG: Circular dependency detected"));

    const res = await request(createApp())
      .patch(`/api/workflows/${WORKFLOW_ID}`)
      .send({
        steps: [
          { id: "a", title: "A", agentId: "77777777-7777-4777-8777-777777777777", dependencies: ["b"] },
          { id: "b", title: "B", agentId: "77777777-7777-4777-8777-777777777777", dependencies: ["a"] },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid workflow DAG: Circular dependency detected");
    expect(logActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workflow.updated" }));
  });

  it("normalizes empty optional workflow step UUIDs on patch", async () => {
    mockWorkflowService.updateDefinition.mockResolvedValue(workflowDefinition());

    const res = await request(createApp())
      .patch(`/api/workflows/${WORKFLOW_ID}`)
      .send({
        steps: [
          {
            id: "send-telegram",
            title: "Send Telegram",
            agentId: "",
            assigneeAgentId: "",
            dependencies: [],
            toolName: "send-telegram",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.updateDefinition).toHaveBeenCalledWith(expect.anything(), WORKFLOW_ID, expect.objectContaining({
      steps: [
        expect.objectContaining({
          id: "send-telegram",
          agentId: undefined,
          assigneeAgentId: undefined,
        }),
      ],
    }));
  });

  it("rejects public scheduledSlotId on trigger and triggers without it", async () => {
    const rejected = await request(createApp())
      .post(`/api/workflows/${WORKFLOW_ID}/runs`)
      .send({ triggeredBy: "board", scheduledSlotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(rejected.status).toBe(400);
    expect(mockWorkflowService.trigger).not.toHaveBeenCalled();

    mockWorkflowService.trigger.mockResolvedValue({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      missionId: null,
      status: "running",
      completedAt: null,
      stepRuns: [],
    });

    const accepted = await request(createApp())
      .post(`/api/workflows/${WORKFLOW_ID}/runs`)
      .send({
        triggeredBy: "board",
        triggerSource: "api",
        runDate: "2026-06-11",
        runNumber: 3,
        runLabel: "2026-06-11 #3",
        parentIssueId: PARENT_ISSUE_ID,
        metadata: { source: "route-test" },
      });

    expect(accepted.status).toBe(201);
    expect(mockWorkflowService.trigger).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ scheduledSlotId: expect.anything() }));
    expect(mockWorkflowService.trigger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workflowId: WORKFLOW_ID,
      companyId: COMPANY_ID,
      triggerSource: "api",
      parentIssueId: PARENT_ISSUE_ID,
    }));
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workflow_run.created" }));
  });

  it("returns run detail with step-run telemetry", async () => {
    const res = await request(createApp()).get(`/api/workflow-runs/${RUN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.run).toEqual(expect.objectContaining({
      id: RUN_ID,
      triggerSource: "api",
      runNumber: 3,
      parentIssueId: PARENT_ISSUE_ID,
      startedAt: "2026-06-11T02:00:00.000Z",
    }));
    expect(res.body.stepRuns[0]).toEqual(expect.objectContaining({
      retryCount: 2,
      sessionId: "session-1",
      lastDispatchRequestId: "dispatch-1",
      metadata: { dispatch: "ok" },
    }));
  });

  it("returns workflow run detail with linked issue work products", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ id: ISSUE_ID, identifier: "CMPA-5230" }]),
        })),
      })),
    };
    mockWorkProductsService.listForIssue.mockResolvedValue([
      {
        id: "77777777-7777-4777-8777-777777777777",
        issueId: ISSUE_ID,
        title: "KR 데일리 리포트 2026-06-16",
        type: "document",
        provider: "local",
        status: "active",
        isPrimary: true,
        url: null,
        summary: null,
        metadata: {
          path: "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/daily/202606/KR_Market_Report_2026-06-16.html",
        },
        createdAt: new Date("2026-06-15T22:22:13.597Z"),
      },
    ]);

    const res = await request(createApp(undefined, db)).get(`/api/workflow-runs/${RUN_ID}/detail`);

    expect(res.status).toBe(200);
    expect(mockWorkProductsService.listForIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(res.body.stepRuns[0]).toEqual(expect.objectContaining({
      issueId: ISSUE_ID,
      issueIdentifier: "CMPA-5230",
      workProducts: [
        expect.objectContaining({
          title: "KR 데일리 리포트 2026-06-16",
          type: "document",
          metadata: expect.objectContaining({
            path: "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/daily/202606/KR_Market_Report_2026-06-16.html",
          }),
          createdAt: "2026-06-15T22:22:13.597Z",
        }),
      ],
    }));
  });

  it("archives definitions instead of physically deleting", async () => {
    mockWorkflowService.deleteDefinition.mockResolvedValue(true);

    const res = await request(createApp()).delete(`/api/workflows/${WORKFLOW_ID}`);

    expect(res.status).toBe(200);
    expect(mockWorkflowService.deleteDefinition).toHaveBeenCalledWith(expect.anything(), WORKFLOW_ID);
    expect(res.body).toEqual({ id: WORKFLOW_ID, status: "archived", archived: true });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workflow.archived" }));
  });

  it("cancels runs through the company-scoped service signature", async () => {
    mockWorkflowService.cancelRun.mockResolvedValue(true);

    const res = await request(createApp()).post(`/api/workflow-runs/${RUN_ID}/cancel`).send({ reason: "operator" });

    expect(res.status).toBe(200);
    expect(mockWorkflowService.cancelRun).toHaveBeenCalledWith(expect.anything(), { runId: RUN_ID, companyId: COMPANY_ID });
    expect(res.body).toEqual({ id: RUN_ID, runId: RUN_ID, status: "cancelled", cancelled: true });
  });

  it("manual-complete keeps existing issue.updated activity shape", async () => {
    mockIssueService.getById.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_ID, status: "in_progress", identifier: "PC-7" });
    mockIssueService.update.mockResolvedValue({ id: ISSUE_ID, companyId: COMPANY_ID, status: "done", identifier: "PC-7" });
    mockWorkflowService.syncRunStatusForIssue.mockResolvedValue({ runId: RUN_ID, workflowId: WORKFLOW_ID, missionId: null, status: "completed", completedAt: new Date("2026-06-11T03:00:00.000Z"), stepRuns: [] });

    const res = await request(createApp()).post(`/api/issues/${ISSUE_ID}/workflow/manual-complete`).send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, { status: "done" });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.updated",
      entityType: "issue",
      entityId: ISSUE_ID,
      details: expect.objectContaining({ source: "workflow.manual-complete", status: "done", _previous: { status: "in_progress" } }),
    }));
  });

  it("returns 404 for cross-company record lookup after auth context is valid", async () => {
    mockWorkflowService.getRun.mockResolvedValue(workflowRun({ companyId: OTHER_COMPANY_ID }));

    const res = await request(createApp()).get(`/api/workflow-runs/${RUN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Workflow run not found");
  });
});
