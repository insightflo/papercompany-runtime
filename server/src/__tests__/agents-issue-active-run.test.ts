import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
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

describe("agent routes issue active run fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses heartbeatRuns.issueId when active run contextSnapshot omits issueId", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
      executionRunId: null,
    });
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-uuid-1",
      status: "running",
      contextSnapshot: {},
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      name: "Runner",
      adapterType: "codex_local",
    });

    const res = await request(createApp()).get("/api/issues/PAP-1/active-run");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "run-1",
      issueId: "issue-uuid-1",
      agentName: "Runner",
      adapterType: "codex_local",
    });
  });
});
