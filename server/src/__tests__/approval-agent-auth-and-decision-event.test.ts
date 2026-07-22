import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const agentActor = (companyId: string) => ({ type: "agent", agentId: "reporter-agent", companyId, runId: null });

describe("approval agent-key access + decision event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "external_automation",
      status: "pending",
      payload: { repository: "acme/runtime", branch: "main", commit: "deadbeef" },
      requestedByAgentId: null,
      requestedByPluginId: "insightflo.github-repository-bridge",
    });
    mockApprovalService.addComment.mockResolvedValue({ id: "comment-1", authorAgentId: "reporter-agent" });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "external_automation",
        status: "approved",
        payload: { repository: "acme/runtime" },
        requestedByAgentId: null,
        requestedByPluginId: "insightflo.github-repository-bridge",
      },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows a same-company agent key to GET an approval", async () => {
    const res = await request(createApp(agentActor("company-1"))).get("/api/approvals/approval-1");
    expect(res.status).toBe(200);
  });

  it("rejects an other-company agent key from GETting an approval (403)", async () => {
    const res = await request(createApp(agentActor("company-other"))).get("/api/approvals/approval-1");
    expect(res.status).toBe(403);
  });

  it("records authorAgentId on a same-company agent comment POST and rejects other-company", async () => {
    const ok = await request(createApp(agentActor("company-1")))
      .post("/api/approvals/approval-1/comments")
      .send({ body: "deployed sha deadbeef" });
    expect(ok.status).toBe(201);
    expect(mockApprovalService.addComment).toHaveBeenCalledWith(
      "approval-1",
      "deployed sha deadbeef",
      expect.objectContaining({ agentId: "reporter-agent" }),
    );

    mockApprovalService.addComment.mockClear();
    const blocked = await request(createApp(agentActor("company-other")))
      .post("/api/approvals/approval-1/comments")
      .send({ body: "x" });
    expect(blocked.status).toBe(403);
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });

  it("emits a minimal plugin-only approval.decided event (no payload) on approve", async () => {
    await request(createApp({ type: "board", userId: "board-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false }))
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "lgtm" });
    const decidedCall = mockLogActivity.mock.calls.find((call: any[]) => call[1]?.action === "approval.decided");
    expect(decidedCall).toBeTruthy();
    const details = decidedCall![1].details;
    expect(details.sourcePluginId).toBe("insightflo.github-repository-bridge");
    expect(details.decision).toBe("approved");
    expect(details).not.toHaveProperty("payload");
  });

  it("does not emit approval.decided for a non-plugin approval", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-2",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
        requestedByPluginId: null,
      },
      applied: true,
    });
    await request(createApp({ type: "board", userId: "board-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false }))
      .post("/api/approvals/approval-2/approve")
      .send({});
    const decidedCall = mockLogActivity.mock.calls.find((call: any[]) => call[1]?.action === "approval.decided");
    expect(decidedCall).toBeUndefined();
  });
});
