import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { missionRoutes } from "../routes/missions.js";
import { errorHandler } from "../middleware/index.js";
import { logActivity } from "../services/activity-log.js";

const mockMissionService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getIssueTree: vi.fn(),
  list: vi.fn(),
  listWorkflowRuns: vi.fn(),
  runActiveMissionOwnerSupervision: vi.fn(),
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

  it("passes mission list date range filters to the mission service", async () => {
    mockMissionService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .get("/api/companies/company-1/missions")
      .query({ from: "2026-04-01", to: "2026-04-29" });

    expect(res.status).toBe(200);
    expect(mockMissionService.list).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      from: "2026-04-01",
      to: "2026-04-29",
    }));
  });

  it("forwards workflow mission source to avoid creating manual planning issues", async () => {
    mockMissionService.create.mockResolvedValue({
      id: "mission-1",
      companyId: "company-1",
      ownerAgentId: "agent-1",
      title: "Workflow mission",
      status: "active",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/missions")
      .send({
        ownerAgentId: "agent-1",
        title: "Workflow mission",
        description: "Created automatically for workflow run: gazua-morning",
        status: "active",
        source: "workflow",
      });

    expect(res.status).toBe(201);
    expect(mockMissionService.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      ownerAgentId: "agent-1",
      title: "Workflow mission",
      source: "workflow",
    }));
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

  it("returns additive owner-action explanations on mission detail", async () => {
    mockMissionService.getById.mockResolvedValue({
      id: "mission-1",
      companyId: "company-1",
      title: "Mission",
      status: "active",
      ownerActionExplanations: [
        {
          ownerActionIssue: {
            id: "owner-action-1",
            identifier: "PC-9",
            title: "Unblock source work",
            status: "done",
            originKind: "mission_main_executor_unblock",
          },
          sourceIssue: {
            id: "source-1",
            identifier: "PC-7",
            title: "Repair adapter handoff",
            status: "todo",
            assigneeAgentId: "agent-2",
          },
          latestDecision: { decision: "retry_source_issue", sourceIssueRef: "PC-7" },
          retryApplied: true,
          status: "retry_applied_no_wakeup",
          explanation: "Retry applied without wakeup.",
        },
      ],
    });

    const res = await request(createApp()).get("/api/missions/mission-1");

    expect(res.status).toBe(200);
    expect(res.body.ownerActionExplanations).toEqual([
      expect.objectContaining({
        status: "retry_applied_no_wakeup",
        ownerActionIssue: expect.objectContaining({ identifier: "PC-9" }),
        sourceIssue: expect.objectContaining({ identifier: "PC-7", status: "todo", assigneeAgentId: "agent-2" }),
        latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
      }),
    ]);
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



  it("runs manual mission owner supervision with read-only safe defaults", async () => {
    mockMissionService.runActiveMissionOwnerSupervision.mockResolvedValue({
      missionIds: ["mission-1"],
      missions: [
        {
          missionId: "mission-1",
          findings: ["dispatch_omission: step=draft"],
          recommendations: [
            { type: "dispatch_missing_unit", missionId: "mission-1", reason: "dispatch missing", safeToAutoApply: true },
          ],
          appliedActions: [],
          commented: true,
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/missions/mission-1/supervision/run")
      .send({ staleAfterMinutes: 15 });

    expect(res.status).toBe(200);
    expect(mockMissionService.getById).toHaveBeenCalledWith("mission-1");
    expect(mockMissionService.runActiveMissionOwnerSupervision).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      missionIds: ["mission-1"],
      staleAfterMinutes: 15,
      applySafeActions: false,
    }));
    expect(res.body).toEqual(expect.objectContaining({
      missionIds: ["mission-1"],
      missions: [
        expect.objectContaining({
          missionId: "mission-1",
          findings: expect.any(Array),
          recommendations: expect.any(Array),
          appliedActions: [],
          commented: true,
        }),
      ],
    }));
  });

  it("writes audit activity when manual mission supervision runs", async () => {
    mockMissionService.runActiveMissionOwnerSupervision.mockResolvedValue({
      missionIds: ["mission-1"],
      missions: [
        {
          missionId: "mission-1",
          findings: ["dispatch_omission: step=draft"],
          recommendations: [
            { type: "dispatch_missing_unit", missionId: "mission-1", reason: "dispatch missing", safeToAutoApply: true },
          ],
          appliedActions: [],
          commented: true,
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/missions/mission-1/supervision/run")
      .send({ staleAfterMinutes: 15 });

    expect(res.status).toBe(200);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "mission.supervision.run",
      entityType: "mission",
      entityId: "mission-1",
      details: expect.objectContaining({
        staleAfterMinutes: 15,
        applySafeActions: false,
        missionCount: 1,
        findingCount: 1,
        recommendationCount: 1,
        appliedActionCount: 0,
      }),
    }));
  });

  it("lets manual supervision explicitly apply only safe actions", async () => {
    mockMissionService.runActiveMissionOwnerSupervision.mockResolvedValue({
      missionIds: ["mission-1"],
      missions: [
        {
          missionId: "mission-1",
          findings: ["dispatch_omission: step=draft"],
          recommendations: [],
          appliedActions: [{ type: "dispatch_missing_step", missionId: "mission-1" }],
          commented: false,
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/missions/mission-1/supervision/run")
      .send({ staleAfterMinutes: "20", applySafeActions: true });

    expect(res.status).toBe(200);
    expect(mockMissionService.runActiveMissionOwnerSupervision).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      missionIds: ["mission-1"],
      staleAfterMinutes: 20,
      applySafeActions: true,
    }));
    expect(res.body.missions[0]).toEqual(expect.objectContaining({
      appliedActions: [expect.objectContaining({ type: "dispatch_missing_step" })],
    }));
  });

  it("blocks manual supervision when route company does not match the mission company", async () => {
    mockMissionService.getById.mockResolvedValue({
      id: "mission-2",
      companyId: "company-2",
      title: "Other Company Mission",
      status: "active",
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/missions/mission-2/supervision/run")
      .send({});

    expect(res.status).toBe(404);
    expect(mockMissionService.runActiveMissionOwnerSupervision).not.toHaveBeenCalled();
  });

  it("blocks manual supervision when the board actor cannot access the mission company", async () => {
    mockMissionService.getById.mockResolvedValue({
      id: "mission-2",
      companyId: "company-2",
      title: "Other Company Mission",
      status: "active",
    });

    const res = await request(createApp())
      .post("/api/companies/company-2/missions/mission-2/supervision/run")
      .send({});

    expect(res.status).toBe(403);
    expect(mockMissionService.runActiveMissionOwnerSupervision).not.toHaveBeenCalled();
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
