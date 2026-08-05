import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import type { HeartbeatRunAttention } from "@paperclipai/shared";

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaryPage: vi.fn(),
  count: vi.fn(),
  stats: vi.fn(),
  attention: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({ getById: vi.fn() }),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }) }),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const runRow = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  invocationSource: "timer",
  triggerDetail: null,
  status: "succeeded",
  startedAt: new Date("2026-07-01T00:00:00.000Z"),
  finishedAt: new Date("2026-07-01T00:10:00.000Z"),
  error: null,
  errorCode: null,
  exitCode: 0,
  signal: null,
  usageJson: null,
  issueId: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:10:00.000Z"),
};

describe("heartbeat-runs bounded read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes no limit when omitted so the service default applies", async () => {
    mockHeartbeatService.list.mockResolvedValue([]);
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs");
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, undefined);
  });

  it("clamps an out-of-range limit to the max of 500", async () => {
    mockHeartbeatService.list.mockResolvedValue([]);
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs?limit=99999");
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, 500);
  });

  it("rejects a non-numeric limit with 400", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs?limit=abc");
    expect(res.status).toBe(400);
    expect(mockHeartbeatService.list).not.toHaveBeenCalled();
  });

  it("serves a cursor page and forwards the parsed cursor", async () => {
    mockHeartbeatService.listSummaryPage.mockResolvedValue({ items: [], nextCursor: null });
    const cursor = encodeURIComponent("2026-07-01T00:00:00.000Z_run-1");
    const res = await request(createApp()).get(
      `/api/companies/company-1/heartbeat-runs/page?limit=100&cursor=${cursor}&agentId=agent-1`,
    );
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.listSummaryPage).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      limit: 100,
      cursor: { createdAt: new Date("2026-07-01T00:00:00.000Z"), id: "run-1" },
    });
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs/page?cursor=not-a-cursor");
    expect(res.status).toBe(400);
  });

  it("serves counts with status filters", async () => {
    mockHeartbeatService.count.mockResolvedValue({
      total: 3,
      queued: 0,
      running: 0,
      succeeded: 2,
      failed: 1,
      cancelled: 0,
      timedOut: 0,
    });
    const res = await request(createApp()).get(
      "/api/companies/company-1/heartbeat-runs/count?status=succeeded,failed",
    );
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.count).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      statuses: ["succeeded", "failed"],
    });
    expect(res.body.total).toBe(3);
  });

  it("rejects unknown status filters with 400", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs/count?status=bogus");
    expect(res.status).toBe(400);
  });

  it("serves 14-day stats", async () => {
    mockHeartbeatService.stats.mockResolvedValue({ days: [], total: 0 });
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs/stats");
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.stats).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      days: undefined,
    });
  });

  it("serves attention summary and items", async () => {
    const attention: HeartbeatRunAttention = {
      summary: { failed: 1, timedOut: 0, cancelled: 0, agents: 1 },
      items: [{ ...runRow, runId: "run-1", status: "failed", error: "boom" }],
      nextCursor: null,
    };
    mockHeartbeatService.attention.mockResolvedValue(attention);
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs/attention?limit=25");
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.attention).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      limit: 25,
      cursor: null,
    });
    expect(res.body.summary.failed).toBe(1);
  });

  it("forwards a parsed cursor to the attention endpoint", async () => {
    mockHeartbeatService.attention.mockResolvedValue({
      summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 },
      items: [],
      nextCursor: null,
    });
    const cursor = encodeURIComponent("2026-07-01T00:00:00.000Z_run-1");
    const res = await request(createApp()).get(
      `/api/companies/company-1/heartbeat-runs/attention?limit=25&cursor=${cursor}`,
    );
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.attention).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      limit: 25,
      cursor: { createdAt: new Date("2026-07-01T00:00:00.000Z"), id: "run-1" },
    });
  });

  it("forwards dismissedRunIds to the attention endpoint", async () => {
    mockHeartbeatService.attention.mockResolvedValue({
      summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 },
      items: [],
      nextCursor: null,
    });
    const res = await request(createApp()).get(
      "/api/companies/company-1/heartbeat-runs/attention?dismissedRunIds=run-1,run-2",
    );
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.attention).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      limit: undefined,
      cursor: null,
      dismissedRunIds: ["run-1", "run-2"],
    });
  });

  it("filters live-runs by agentId when provided", async () => {
    const live = [{ ...runRow, status: "running" }];
    const dbMock = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => live,
            }),
          }),
        }),
      }),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(dbMock as any));
    app.use(errorHandler);

    const res = await request(app).get("/api/companies/company-1/live-runs?agentId=agent-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe("agent-1");
  });
});
