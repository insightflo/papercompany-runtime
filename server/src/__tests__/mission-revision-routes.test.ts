import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { missionRoutes } from "../routes/missions.js";
import { logActivity } from "../services/activity-log.js";

const create = vi.hoisted(() => vi.fn());
vi.mock("../services/missions.js", () => ({ missionService: () => ({ create }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));

describe("revision mission route", () => {
  it("forwards source IDs and logs the persisted resolved IDs (not editable prose)", async () => {
    const companyId = randomUUID(), sourceMissionId = randomUUID(), sourceWorkflowRunId = randomUUID();
    const mission = { id: randomUUID(), companyId, sourceMissionId, sourceWorkflowRunId, status: "planning" };
    create.mockResolvedValue(mission);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { actor: { type: "board", userId: "local-board", source: "local_implicit" } }); next(); });
    app.use("/api", missionRoutes({} as Db));
    const result = await request(app).post(`/api/companies/${companyId}/missions`).send({
      title: "Revision", ownerAgentId: randomUUID(), sourceMissionId,
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject(mission);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceMissionId }));
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "mission.created", details: expect.objectContaining({ sourceMissionId, sourceWorkflowRunId }),
    }));
  });
});
