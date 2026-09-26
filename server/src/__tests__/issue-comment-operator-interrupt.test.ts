import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { heartbeatRuns } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { operatorInterruptFilePath } from "../services/operator-interrupt.js";

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

vi.mock("../services/standalone-issue-execution-contract.js", () => ({
  standaloneIssueExecutionContractService: () => ({
    validateAssigneeChange: vi.fn(async () => null),
  }),
}));

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function createApp(db: any, actorType: "board" | "agent" = "board") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor =
      actorType === "agent"
        ? {
            type: "agent",
            agentId: AGENT_ID,
            companyId: "company-1",
            runId: null,
            source: "agent_api_key",
          }
        : {
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

function makeIssue(status: "todo" | "done" | "cancelled" = "todo") {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-926",
    title: "Operator interrupt delivery",
    missionId: "mission-1",
  };
}

/**
 * db mock that dispatches by table reference: heartbeatRuns selects resolve to
 * `activeRuns` (operator-interrupt service query), anything else resolves to a
 * workflow step run row (buildIssueWakeContext in the wakeup path).
 */
function makeDb(activeRuns: Array<{ id: string; agentId: string }> = [], options: { failRunsQuery?: boolean } = {}) {
  const runsWhere = options.failRunsQuery
    ? async () => {
        throw new Error("db unavailable");
      }
    : async () => activeRuns;
  const stepRunChain = {
    where: vi.fn(async () => [{ workflowRunId: "workflow-run-1", stepId: "publish" }]),
  };
  const runsChain = { where: vi.fn(runsWhere) };
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => (table === heartbeatRuns ? runsChain : stepRunChain),
    })),
  };
}

describe("issue comment operator interrupt delivery", () => {
  let paperclipHome: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-interrupt-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "stop the wide scan now",
      createdAt: new Date("2026-09-26T10:00:00.000Z"),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_HOME;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
  });

  it("writes an interrupt inbox file for a user comment when the issue has an active run", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    const db = makeDb([{ id: "run-1", agentId: AGENT_ID }]);

    const res = await request(createApp(db))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "stop the wide scan now" });

    expect(res.status).toBe(201);
    const inboxPath = operatorInterruptFilePath(
      path.join(paperclipHome, "instances", "default", "workspaces", AGENT_ID),
      ISSUE_ID,
    );
    const raw = await fs.readFile(inboxPath, "utf8");
    const payload = JSON.parse(raw) as Record<string, string>;
    expect(payload).toEqual({
      commentId: "comment-1",
      body: "stop the wide scan now",
      createdAt: "2026-09-26T10:00:00.000Z",
      issueId: ISSUE_ID,
    });
  });

  it("does not write an interrupt file for agent comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    const db = makeDb([{ id: "run-1", agentId: AGENT_ID }]);

    const res = await request(createApp(db, "agent"))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "agent status note" });

    expect(res.status).toBe(201);
    const workspacesDir = path.join(paperclipHome, "instances", "default", "workspaces");
    await expect(fs.access(workspacesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write an interrupt file when no active run exists for the issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    const db = makeDb([]);

    const res = await request(createApp(db))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "take a look when free" });

    expect(res.status).toBe(201);
    const workspacesDir = path.join(paperclipHome, "instances", "default", "workspaces");
    await expect(fs.access(workspacesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps comment creation working when interrupt delivery fails", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    const db = makeDb([{ id: "run-1", agentId: AGENT_ID }], { failRunsQuery: true });

    const res = await request(createApp(db))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "still deliver me" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });
});
