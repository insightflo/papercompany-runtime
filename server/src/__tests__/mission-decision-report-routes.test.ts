import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { missionRoutes } from "../routes/missions.js";
import { errorHandler } from "../middleware/index.js";
import { logActivity } from "../services/activity-log.js";
import { unprocessable } from "../errors.js";

const mockMissionService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  getIssueTree: vi.fn(),
  listWorkflowRuns: vi.fn(),
  runActiveMissionOwnerSupervision: vi.fn(),
}));
const mockDecisionReports = vi.hoisted(() => ({
  applyMissionDecisionReports: vi.fn(),
  getMissionDecisionLog: vi.fn(),
}));

vi.mock("../services/missions.js", () => ({ missionService: () => mockMissionService }));
vi.mock("../services/missions/mission-decision-reports.js", () => mockDecisionReports);
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));

describe("mission decision report routes", () => {
  const mockMissionService = vi.hoisted(() => ({
    getById: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    getIssueTree: vi.fn(),
    listWorkflowRuns: vi.fn(),
    runActiveMissionOwnerSupervision: vi.fn(),
  }));
  const mockDecisionReports = vi.hoisted(() => ({
    applyMissionDecisionReports: vi.fn(),
    getMissionDecisionLog: vi.fn(),
  }));

  vi.mock("../services/missions.js", () => ({ missionService: () => mockMissionService }));
  vi.mock("../services/missions/mission-decision-reports.js", () => mockDecisionReports);
  vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));

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

  const mission = { id: "mission-1", companyId: "company-1", title: "Mission", status: "active" };

  beforeEach(() => {
    vi.resetAllMocks();
    mockMissionService.getById.mockResolvedValue(mission);
  });

  it("POST /missions/:id/decision-reports applies reports and logs activity", async () => {
    mockMissionService.getById.mockResolvedValue(mission);
    mockDecisionReports.applyMissionDecisionReports.mockResolvedValue({
      missionId: "mission-1",
      revision: 2,
      updatedAt: "2026-09-05T00:00:00.000Z",
      appliedUpdates: 1,
      decisions: [],
      stateMarkdown: "# Mission State",
    });

    const res = await request(createApp())
      .post("/api/missions/mission-1/decision-reports")
      .send({ updates: [{ id: "D-1", summary: "Use PGlite", status: "confirmed" }] });

    expect(res.status).toBe(201);
    expect(res.body.revision).toBe(2);
    expect(mockDecisionReports.applyMissionDecisionReports).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "company-1", missionId: "mission-1" }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mission.decisions.reported",
        entityType: "mission",
        entityId: "mission-1",
      }),
    );
  });

  it("blocks an agent key from another company", async () => {
    mockMissionService.getById.mockResolvedValue(mission);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-other",
      companyId: "company-2",
    }))
      .post("/api/missions/mission-1/decision-reports")
      .send({ updates: [{ id: "D-1", summary: "x" }] });

    expect(res.status).toBe(403);
    expect(mockDecisionReports.applyMissionDecisionReports).not.toHaveBeenCalled();
  });

  it("maps validation failures to 422", async () => {
    mockMissionService.getById.mockResolvedValue(mission);
    mockDecisionReports.applyMissionDecisionReports.mockRejectedValue(
      unprocessable("Invalid mission decision report"),
    );

    const res = await request(createApp())
      .post("/api/missions/mission-1/decision-reports")
      .send({ updates: [{ id: "D-1", status: "draft" }] });

    expect(res.status).toBe(422);
  });

  it("GET /missions/:id/decision-log returns the decision log for same-company actors", async () => {
    mockMissionService.getById.mockResolvedValue(mission);
    mockDecisionReports.getMissionDecisionLog.mockResolvedValue({
      missionId: "mission-1",
      revision: 1,
      updatedAt: "2026-09-05T00:00:00.000Z",
      decisions: [{ id: "D-1", summary: "Use PGlite", status: "confirmed" }],
      stateMarkdown: "# Mission State",
    });

    const res = await request(createApp())
      .get("/api/missions/mission-1/decision-log");

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(mockDecisionReports.getMissionDecisionLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ missionId: "mission-1" }),
    );
  });

  it("GET /missions/:id/decision-log returns an empty view instead of 404 when no rolling state exists", async () => {
    mockDecisionReports.getMissionDecisionLog.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/api/missions/mission-1/decision-log");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      missionId: "mission-1",
      revision: 0,
      updatedAt: null,
      decisions: [],
      stateMarkdown: "",
    });
  });
});
