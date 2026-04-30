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
  assertCheckoutOwner: vi.fn(),
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
const mockLogMaintenanceDecisionActionMismatch = vi.hoisted(() => vi.fn(async () => null));

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
  projectService: () => ({ getById: vi.fn(async () => null) }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workflowService: {
    syncRunStatusForIssue: vi.fn(async () => undefined),
  },
  workProductService: () => ({}),
}));

vi.mock("../services/srb/source-status-sync.js", () => ({
  syncSrbSourceIssueStatus: vi.fn(async () => []),
}));

vi.mock("../services/maintenance/decision-audit.js", () => ({
  logMaintenanceDecisionActionMismatch: mockLogMaintenanceDecisionActionMismatch,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
      companyIds: ["company-1"],
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue routes agent patch guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
  });

  it("rejects agent PATCH todo -> in_progress and requires checkout", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAP-999",
      title: "Guard direct in_progress patch",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Agents must use checkout to move an issue into in_progress",
    });
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("soft-audits maintenance decision mismatch when an agent closes an issue via PATCH", async () => {
    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      projectId: "project-1",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAP-1000",
      title: "Kiosk payment outage",
      description: "Customer-facing outage. affected system: kiosk payment. symptom: checkout down. time window: today.",
      metadata: {},
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "fixed" });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "fixed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(issue.id, { status: "done" });
    expect(mockLogMaintenanceDecisionActionMismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        actor: expect.objectContaining({
          actorType: "agent",
          actorId: "22222222-2222-4222-8222-222222222222",
          agentId: "22222222-2222-4222-8222-222222222222",
          runId: "run-1",
        }),
        issue: expect.objectContaining({
          id: issue.id,
          identifier: "PAP-1000",
          projectId: "project-1",
        }),
        attemptedAction: "issue.patch",
        attemptedStatus: "done",
        attemptedComment: "fixed",
        decision: expect.objectContaining({
          recommendedNextAction: "escalate_incident",
          warnings: expect.arrayContaining(["completion_evidence_missing"]),
        }),
      }),
    );
  });
});
