import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { missionPlanTemplateRoutes } from "../routes/mission-plan-templates.js";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockAccessService = vi.hoisted(() => ({ canUser: vi.fn(), hasPermission: vi.fn() }));
const mockTemplateService = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), createCustom: vi.fn(), update: vi.fn(),
  removeCustom: vi.fn(), duplicate: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  missionPlanTemplateService: () => mockTemplateService,
  logActivity: mockLogActivity,
}));

const template = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  key: "research-report-qa",
  name: "Research → report → QA",
  selectionDescription: "Use for research.",
  instructions: "Split research and QA.",
  origin: "system_default",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", missionPlanTemplateRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("mission plan template routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockTemplateService.list.mockResolvedValue([template]);
    mockTemplateService.get.mockResolvedValue(template);
    mockTemplateService.createCustom.mockResolvedValue({ ...template, origin: "custom", key: "custom-1" });
    mockTemplateService.update.mockResolvedValue(template);
    mockTemplateService.duplicate.mockResolvedValue({ ...template, origin: "custom", key: "custom-2" });
  });

  it("lets a same-company agent list enabled templates but not request disabled rows", async () => {
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });
    const response = await request(app).get("/api/companies/company-1/mission-plan-templates?includeDisabled=true");

    expect(response.status).toBe(200);
    expect(mockTemplateService.list).toHaveBeenCalledWith("company-1", { includeDisabled: false });
  });

  it("rejects an agent reading another company's catalog", async () => {
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });
    const response = await request(app).get("/api/companies/company-2/mission-plan-templates");
    expect(response.status).toBe(403);
    expect(mockTemplateService.list).not.toHaveBeenCalled();
  });

  it("lets a local board create a custom template and logs bounded details", async () => {
    const app = createApp({ type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit" });
    const response = await request(app).post("/api/companies/company-1/mission-plan-templates").send({
      name: "Custom",
      selectionDescription: "Use for custom work.",
      instructions: "Secret-looking but non-secret body that must not enter activity details.",
    });

    expect(response.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.mission_plan_template_created",
      details: { templateId: template.id, key: "custom-1", origin: "custom", enabled: true },
    }));
    expect(JSON.stringify(mockLogActivity.mock.calls[0]?.[1]?.details)).not.toContain("Secret-looking");
  });

  it("validates strict create payloads", async () => {
    const app = createApp({ type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit" });
    const response = await request(app).post("/api/companies/company-1/mission-plan-templates").send({
      name: "Custom", selectionDescription: "Use it.", instructions: "Do it.", origin: "system_default",
    });
    expect(response.status).toBe(400);
    expect(mockTemplateService.createCustom).not.toHaveBeenCalled();
  });

  it("supports update, duplicate, and delete mutations", async () => {
    const app = createApp({ type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit" });
    expect((await request(app).patch(`/api/companies/company-1/mission-plan-templates/${template.id}`).send({ enabled: false })).status).toBe(200);
    expect((await request(app).post(`/api/companies/company-1/mission-plan-templates/${template.id}/duplicate`).send({ name: "Copy" })).status).toBe(201);
    expect((await request(app).delete(`/api/companies/company-1/mission-plan-templates/${template.id}`)).status).toBe(204);
  });

  it("blocks same-company agents without Instructions management permission from mutation", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", permissions: {} });
    const app = createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1" });
    const response = await request(app).patch(`/api/companies/company-1/mission-plan-templates/${template.id}`).send({ enabled: false });
    expect(response.status).toBe(403);
    expect(mockTemplateService.update).not.toHaveBeenCalled();
  });
});
