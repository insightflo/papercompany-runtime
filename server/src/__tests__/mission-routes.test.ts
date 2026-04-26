import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { missionRoutes } from "../routes/missions.js";
import { errorHandler } from "../middleware/index.js";

const mockMissionService = vi.hoisted(() => ({
  getById: vi.fn(),
  getIssueTree: vi.fn(),
  listWorkflowRuns: vi.fn(),
}));

vi.mock("../services/missions.js", () => ({
  missionService: () => mockMissionService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "authenticated",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", missionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("mission routes subresources", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMissionService.getById.mockResolvedValue({
      id: "mission-1",
      companyId: "company-1",
      title: "Mission",
      status: "active",
    });
  });

  it("returns mission issues from the mission service", async () => {
    mockMissionService.getIssueTree.mockResolvedValue([
      { id: "issue-1", title: "Mission issue", missionId: "mission-1" },
    ]);

    const res = await request(createApp()).get("/api/missions/mission-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "issue-1", title: "Mission issue", missionId: "mission-1" }),
    ]);
    expect(mockMissionService.getIssueTree).toHaveBeenCalledWith("mission-1");
  });

  it("returns mission workflow runs from the mission service", async () => {
    mockMissionService.listWorkflowRuns.mockResolvedValue([
      {
        id: "run-1",
        missionId: "mission-1",
        workflowId: "workflow-1",
        companyId: "company-1",
        status: "running",
        triggeredBy: "system",
        startedAt: null,
        completedAt: null,
        createdAt: "2026-04-15T00:00:00.000Z",
        workflowName: "Mission Workflow",
        stepRuns: [],
        steps: [
          {
            stepId: "draft",
            name: "Draft",
            agentId: "agent-1",
            dependencies: [],
            description: null,
            toolNames: ["search-docs"],
            knowledgeBaseIds: ["kb-product"],
            status: "running",
            issueId: "issue-1",
            issue: {
              id: "issue-1",
              identifier: "CMP-1",
              title: "Draft mission brief",
              status: "in_progress",
              assigneeAgentId: "agent-1",
            },
            startedAt: null,
            completedAt: null,
          },
        ],
        progress: {
          totalSteps: 1,
          pendingSteps: 0,
          runningSteps: 1,
          completedSteps: 0,
          failedSteps: 0,
          skippedSteps: 0,
        },
      },
    ]);

    const res = await request(createApp()).get("/api/missions/mission-1/workflow-runs");
    const payload = Array.isArray(res.body) ? res.body : JSON.parse(res.text);

    expect(res.status).toBe(200);
    expect(payload).toEqual([
      expect.objectContaining({
        id: "run-1",
        missionId: "mission-1",
        workflowName: "Mission Workflow",
        progress: expect.objectContaining({
          totalSteps: 1,
          runningSteps: 1,
        }),
      }),
    ]);
    expect(mockMissionService.listWorkflowRuns).toHaveBeenCalledWith("mission-1");
  });

  it("blocks mission issues when the board actor cannot access the mission company", async () => {
    mockMissionService.getById.mockResolvedValue({
      id: "mission-2",
      companyId: "company-2",
      title: "Other Company Mission",
      status: "active",
    });

    const res = await request(createApp()).get("/api/missions/mission-2/issues");

    expect(res.status).toBe(403);
    expect(mockMissionService.getIssueTree).not.toHaveBeenCalled();
  });

  it("blocks mission workflow runs when the board actor cannot access the mission company", async () => {
    mockMissionService.getById.mockResolvedValue({
      id: "mission-2",
      companyId: "company-2",
      title: "Other Company Mission",
      status: "active",
    });

    const res = await request(createApp()).get("/api/missions/mission-2/workflow-runs");

    expect(res.status).toBe(403);
    expect(mockMissionService.listWorkflowRuns).not.toHaveBeenCalled();
  });
});
