import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockOpenWorkProductWithDefaultApp = vi.hoisted(() => vi.fn(async () => ({
  kind: "url",
  value: "https://example.com/report.html",
})));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockWorkProductsService = vi.hoisted(() => ({
  getById: vi.fn(),
  listForIssue: vi.fn(async () => []),
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
  workProductService: () => mockWorkProductsService,
}));

vi.mock("../services/work-products.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/work-products.js")>();
  return {
    ...actual,
    openWorkProductWithDefaultApp: mockOpenWorkProductWithDefaultApp,
  };
});

function createApp(actor: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actor,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("work product routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkProductsService.getById.mockResolvedValue({
      id: "work-product-1",
      companyId: "company-1",
      issueId: "issue-1",
      type: "document",
      provider: "local",
      title: "Report",
      url: null,
      status: "active",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "unknown",
      summary: null,
      metadata: { path: "/tmp/report.html" },
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      externalId: null,
      createdByRunId: null,
      createdAt: new Date("2026-06-16T00:00:00.000Z"),
      updatedAt: new Date("2026-06-16T00:00:00.000Z"),
    });
  });

  it("opens a work product through the OS default application", async () => {
    const res = await request(createApp()).post("/api/work-products/work-product-1/open").send({});

    expect(res.status).toBe(200);
    expect(mockOpenWorkProductWithDefaultApp).toHaveBeenCalledWith(expect.objectContaining({ id: "work-product-1" }));
    expect(res.body).toEqual({
      ok: true,
      target: { kind: "url", value: "https://example.com/report.html" },
    });
  });

  it("requires board access to open work products on the host OS", async () => {
    const res = await request(createApp({ type: "agent" })).post("/api/work-products/work-product-1/open").send({});

    expect(res.status).toBe(403);
    expect(mockOpenWorkProductWithDefaultApp).not.toHaveBeenCalled();
  });
});
