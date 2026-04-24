import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({
    listForIssue: vi.fn(async () => []),
    link: vi.fn(async () => []),
    unlink: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workflowService: {
    syncRunStatusForIssue: vi.fn(async () => undefined),
  },
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("work-items alias routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        identifier: "PAP-101",
        issueNumber: 101,
        title: "Alias route work item",
        description: null,
        status: "todo",
        priority: "medium",
        projectId: "22222222-2222-4222-8222-222222222222",
        projectWorkspaceId: "33333333-3333-4333-8333-333333333333",
        executionWorkspaceId: "44444444-4444-4444-8444-444444444444",
        parentId: "55555555-5555-4555-8555-555555555555",
        goalId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
        labelIds: [],
        labels: [],
        createdAt: new Date("2026-04-07T00:00:00Z"),
        updatedAt: new Date("2026-04-07T00:00:00Z"),
      },
    ]);
  });

  it("lists company work-items with alias query params and alias response fields", async () => {
    const res = await request(createApp()).get(
      "/api/companies/company-1/work-items?status=todo&workContextId=22222222-2222-4222-8222-222222222222",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "todo",
        projectId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        workContextId: "22222222-2222-4222-8222-222222222222",
        workContextSpaceId: "33333333-3333-4333-8333-333333333333",
        executionContextId: "44444444-4444-4444-8444-444444444444",
        parentWorkItemId: "55555555-5555-4555-8555-555555555555",
        workItemNumber: 101,
      }),
    ]);
  });
});
