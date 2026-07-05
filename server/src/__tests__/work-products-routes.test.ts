import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
}));

const mockWorkProductsService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  listForIssue: vi.fn(async () => []),
}));

type MockWorkProductRouteGuardDecision = {
  block: boolean;
  reason: "ok" | "workflow_card_requires_artifact_marker";
  issueExecutionCardHash: string | null;
  message: string | null;
};

const mockWorkProductRouteGuard = vi.hoisted(() =>
  vi.fn(async (): Promise<MockWorkProductRouteGuardDecision> => ({
    block: false,
    reason: "ok",
    issueExecutionCardHash: null,
    message: null,
  })),
);

function allowWorkProductRoute(): MockWorkProductRouteGuardDecision {
  return {
    block: false,
    reason: "ok",
    issueExecutionCardHash: null,
    message: null,
  };
}

function blockWorkProductRoute(message: string): MockWorkProductRouteGuardDecision {
  return {
    block: true,
    reason: "workflow_card_requires_artifact_marker",
    issueExecutionCardHash: "cardhash-1",
    message,
  };
}

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

vi.mock("../services/issue-execution-cards/work-product-route-guard.js", () => ({
  resolveAgentWorkProductRouteGuard: mockWorkProductRouteGuard,
}));

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
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      projectId: null,
    });
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockWorkProductRouteGuard.mockResolvedValue(allowWorkProductRoute());
    mockWorkProductsService.createForIssue.mockResolvedValue({
      id: "work-product-2",
      companyId: "company-1",
      issueId: "issue-1",
      type: "document",
      provider: "manual",
      title: "Report",
      url: "https://example.com/report",
      status: "active",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "unknown",
      summary: null,
      metadata: null,
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      externalId: null,
      createdByRunId: null,
      createdAt: new Date("2026-06-16T00:00:00.000Z"),
      updatedAt: new Date("2026-06-16T00:00:00.000Z"),
    });
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

  it("blocks agent direct work-product POST when the workflow card requires [ARTIFACT] registration", async () => {
    mockWorkProductRouteGuard.mockResolvedValueOnce(
      blockWorkProductRoute("Emit `[ARTIFACT]: <absolute path>`; issueExecutionCardHash=cardhash-1"),
    );

    const res = await request(createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" }))
      .post("/api/issues/issue-1/work-products")
      .send({
        type: "document",
        provider: "manual",
        title: "Report",
        url: "https://example.com/report",
        status: "active",
        reviewState: "none",
        isPrimary: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("[ARTIFACT]: <absolute path>");
    expect(res.body.error).toContain("issueExecutionCardHash=cardhash-1");
    expect(mockWorkProductsService.createForIssue).not.toHaveBeenCalled();
  });

  it("keeps the normal work-product POST path available when the guard allows it", async () => {
    const res = await request(createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" }))
      .post("/api/issues/issue-1/work-products")
      .send({
        type: "document",
        provider: "manual",
        title: "Report",
        url: "https://example.com/report",
        status: "active",
        reviewState: "none",
        isPrimary: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockWorkProductRouteGuard).toHaveBeenCalledWith({
      db: {},
      companyId: "company-1",
      issueId: "issue-1",
      actorType: "agent",
    });
    expect(mockWorkProductsService.createForIssue).toHaveBeenCalledWith("issue-1", "company-1", expect.objectContaining({
      title: "Report",
      projectId: null,
    }));
  });

  it("returns a browser-openable target for a work product", async () => {
    const res = await request(createApp()).post("/api/work-products/work-product-1/open").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      target: { kind: "url", value: "/api/work-products/work-product-1/content" },
    });
  });

  it("streams local work product content to the browser", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-work-product-route-"));
    const reportPath = path.join(dir, "report.html");
    writeFileSync(reportPath, "<h1>report</h1>\n", "utf8");
    mockWorkProductsService.getById.mockResolvedValueOnce({
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
      metadata: { path: reportPath },
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      externalId: null,
      createdByRunId: null,
      createdAt: new Date("2026-06-16T00:00:00.000Z"),
      updatedAt: new Date("2026-06-16T00:00:00.000Z"),
    });

    try {
      const res = await request(createApp()).get("/api/work-products/work-product-1/content");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("<h1>report</h1>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires board access to request a browser-open target", async () => {
    const res = await request(createApp({ type: "agent" })).post("/api/work-products/work-product-1/open").send({});

    expect(res.status).toBe(403);
  });
});
