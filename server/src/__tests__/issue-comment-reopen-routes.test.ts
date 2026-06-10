import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockSyncSrbSourceIssueStatus = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workflowService: {
    syncRunStatusForIssue: vi.fn(async () => undefined),
  },
  workProductService: () => ({}),
}));

vi.mock("../services/srb/source-status-sync.js", () => ({
  syncSrbSourceIssueStatus: mockSyncSrbSourceIssueStatus,
}));

function createApp(db: any = {}) {
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
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function makeWorkflowContextDb(stepRun: { workflowRunId: string; stepId: string }) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => [stepRun]),
  };
  return {
    select: vi.fn(() => query),
  };
}

function makeIssue(status: "todo" | "done" | "cancelled") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
    expect(mockSyncSrbSourceIssueStatus).not.toHaveBeenCalled();
  });

  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      status: "todo",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
    expect(mockSyncSrbSourceIssueStatus).toHaveBeenCalledWith({
      db: expect.anything(),
      issueId: "11111111-1111-4111-8111-111111111111",
      status: "todo",
    });
  });

  it("does not reopen cancelled issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "resume", reopen: true });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not reopen cancelled issues via the comment route", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("cancelled"));

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "resume", reopen: true });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("adds workflow context to assignee comment wakeups", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("todo"),
      missionId: "mission-1",
    });
    const db = makeWorkflowContextDb({
      workflowRunId: "workflow-run-1",
      stepId: "publish",
    });

    const res = await request(createApp(db))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please continue" });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-1",
          mutation: "comment",
          missionId: "mission-1",
          workflowRunId: "workflow-run-1",
          stepId: "publish",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          taskId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          missionId: "mission-1",
          workflowRunId: "workflow-run-1",
          workflowStepId: "publish",
          stepId: "publish",
          source: "issue.comment",
          wakeReason: "issue_commented",
        }),
      }),
    );
  });
});
