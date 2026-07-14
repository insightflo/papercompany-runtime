import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";
import { logActivity } from "../services/activity-log.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TOOL_ID = "33333333-3333-4333-8333-333333333333";

const mockToolService = vi.hoisted(() => ({
  createDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  getDefinitionById: vi.fn(),
  listDefinitions: vi.fn(),
  updateDefinition: vi.fn(),
}));

vi.mock("../services/tools/registry.js", () => ({
  toolService: mockToolService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

function toolDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: TOOL_ID,
    companyId: COMPANY_ID,
    name: "daily-tech-scout",
    description: "Collect daily AI and tech signals.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    adapterType: "http",
    adapterConfig: { url: "https://example.test/tools/daily-tech-scout" },
    enabled: true,
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T01:00:00.000Z"),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user-1",
  companyIds: [COMPANY_ID],
  source: "authenticated",
  isInstanceAdmin: false,
}, db: unknown = {}, options: { executeTest?: unknown } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", toolDefinitionRoutes(db as never, options));
  app.use(errorHandler);
  return app;
}

describe("tool definition routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockToolService.listDefinitions.mockResolvedValue([toolDefinition()]);
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition());
  });

  it("lists tool definitions only for the requested company", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/tools`);

    expect(res.status).toBe(200);
    expect(mockToolService.listDefinitions).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY_ID });
    expect(res.body).toEqual([expect.objectContaining({ id: TOOL_ID, companyId: COMPANY_ID, name: "daily-tech-scout" })]);
  });

  it("blocks tool definition reads across company boundaries", async () => {
    const res = await request(createApp()).get(`/api/companies/${OTHER_COMPANY_ID}/tools`);

    expect(res.status).toBe(403);
    expect(mockToolService.listDefinitions).not.toHaveBeenCalled();
  });

  it("blocks agent credentials from reading or changing tool definitions", async () => {
    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      runId: null,
    };

    const list = await request(createApp(agentActor)).get(`/api/companies/${COMPANY_ID}/tools`);
    const create = await request(createApp(agentActor))
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send({ name: "agent-tool", adapterType: "http", adapterConfig: {} });

    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
    expect(mockToolService.listDefinitions).not.toHaveBeenCalled();
    expect(mockToolService.createDefinition).not.toHaveBeenCalled();
  });

  it("creates a tool definition and logs activity", async () => {
    mockToolService.createDefinition.mockResolvedValue(toolDefinition({ enabled: false }));

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send({
        name: "daily-tech-scout",
        description: "Collect daily AI and tech signals.",
        inputSchema: { type: "object" },
        adapterType: "http",
        adapterConfig: { url: "https://example.test/tools/daily-tech-scout" },
        enabled: false,
      });

    expect(res.status).toBe(201);
    expect(mockToolService.createDefinition).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      name: "daily-tech-scout",
      description: "Collect daily AI and tech signals.",
      inputSchema: { type: "object" },
      adapterType: "http",
      adapterConfig: { url: "https://example.test/tools/daily-tech-scout" },
      enabled: false,
    });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "board-user-1",
      action: "company.tool_created",
      entityType: "tool_definition",
      entityId: TOOL_ID,
    }));
  });

  it("updates a company-owned tool definition and logs activity", async () => {
    mockToolService.updateDefinition.mockResolvedValue(toolDefinition({
      description: "Updated",
      enabled: false,
    }));
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ description: "Updated", enabled: false });

    expect(res.status).toBe(200);
    expect(mockToolService.getDefinitionById).toHaveBeenCalledWith(expect.anything(), TOOL_ID);
    expect(mockToolService.updateDefinition).toHaveBeenCalledWith(expect.anything(), TOOL_ID, {
      description: "Updated",
      enabled: false,
    });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.tool_updated",
      entityType: "tool_definition",
      entityId: TOOL_ID,
    }));
  });

  it("does not update a tool definition owned by another company", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({ companyId: OTHER_COMPANY_ID }));

    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ enabled: false });

    expect(res.status).toBe(404);
    expect(mockToolService.updateDefinition).not.toHaveBeenCalled();
  });

  it("does not update or delete a source-managed tool definition", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({
      adapterType: "builtin",
      adapterConfig: { source: "tool-registry", command: "pnpm collect" },
    }));

    const update = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ enabled: false });
    const remove = await request(createApp())
      .delete(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`);

    expect(update.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(mockToolService.updateDefinition).not.toHaveBeenCalled();
    expect(mockToolService.deleteDefinition).not.toHaveBeenCalled();
  });

  it("allows a board-only atomic source-detaching conversion to http", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({
      adapterType: "builtin",
      adapterConfig: { source: "tool-registry", command: "pnpm collect" },
    }));
    mockToolService.updateDefinition.mockResolvedValue(toolDefinition({
      adapterType: "http",
      adapterConfig: { url: "https://n8n.example.test/webhook/daily-tech-scout", method: "POST" },
    }));

    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({
        adapterType: "http",
        adapterConfig: {
          url: "https://n8n.example.test/webhook/daily-tech-scout",
          method: "POST",
        },
      });
    expect(res.status).toBe(200);
    expect(mockToolService.updateDefinition).toHaveBeenCalledWith(expect.anything(), TOOL_ID, {
      adapterType: "http",
      adapterConfig: {
        url: "https://n8n.example.test/webhook/daily-tech-scout",
        method: "POST",
      },
    });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.tool_updated",
      entityId: TOOL_ID,
    }));
  });

  it("allows a board-only atomic source-detaching conversion to mcp", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({
      adapterType: "builtin",
      adapterConfig: { source: "tool-registry", command: "pnpm collect" },
    }));
    mockToolService.updateDefinition.mockResolvedValue(toolDefinition({
      adapterType: "mcp",
      adapterConfig: { url: "https://mcp.example.test/mcp", toolName: "daily-tech-scout" },
    }));
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({
        adapterType: "mcp",
        adapterConfig: { url: "https://mcp.example.test/mcp", toolName: "daily-tech-scout" },
      });
    expect(res.status).toBe(200);
    expect(mockToolService.updateDefinition).toHaveBeenCalledWith(expect.anything(), TOOL_ID, {
      adapterType: "mcp",
      adapterConfig: { url: "https://mcp.example.test/mcp", toolName: "daily-tech-scout" },
    });
  });
  it("still blocks a source-managed conversion that keeps registry ownership", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({
      adapterType: "builtin",
      adapterConfig: { source: "tool-registry", command: "pnpm collect" },
    }));
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({
        adapterType: "http",
        adapterConfig: { source: "tool-registry", url: "https://example.test", method: "POST" },
      });
    expect(res.status).toBe(409);
    expect(mockToolService.updateDefinition).not.toHaveBeenCalled();
  });

  it("returns a conflict when a tool name already exists", async () => {
    mockToolService.createDefinition.mockRejectedValue({
      code: "23505",
      constraint: "tool_definitions_company_id_name_key",
    });

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send({ name: "daily-tech-scout", adapterType: "http", adapterConfig: {} });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Tool "daily-tech-scout" already exists.' });
  });

  it("returns a conflict when an update duplicates another tool name", async () => {
    mockToolService.updateDefinition.mockRejectedValue({
      code: "23505",
      constraint: "tool_definitions_company_id_name_key",
    });

    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ name: "existing-tool" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Tool "existing-tool" already exists.' });
  });

  it("deletes a company-owned tool definition and logs activity", async () => {
    mockToolService.deleteDefinition.mockResolvedValue(true);

    const res = await request(createApp())
      .delete(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockToolService.deleteDefinition).toHaveBeenCalledWith(expect.anything(), TOOL_ID);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.tool_deleted",
      entityType: "tool_definition",
      entityId: TOOL_ID,
    }));
  });
  it("runs a board-only tool test and logs activity", async () => {
    const mockExecuteTest = vi.fn(async () => ({
      ok: true,
      status: "success" as const,
      httpStatus: 200,
      result: { ok: true },
    }));

    const res = await request(createApp(undefined, undefined, { executeTest: mockExecuteTest }))
      .post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`)
      .send({ input: { query: "ai" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, status: "success", httpStatus: 200 }));
    expect(mockExecuteTest).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      tool: expect.objectContaining({ id: TOOL_ID }),
      input: { query: "ai" },
    }));
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: COMPANY_ID,
      action: "company.tool_tested",
      entityType: "tool_definition",
      entityId: TOOL_ID,
      details: expect.objectContaining({ ok: true, httpStatus: 200 }),
    }));
  });

  it("blocks agent credentials from testing a tool", async () => {
    const mockExecuteTest = vi.fn();
    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      runId: null,
    };

    const res = await request(createApp(agentActor, undefined, { executeTest: mockExecuteTest }))
      .post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`)
      .send({ input: {} });

    expect(res.status).toBe(403);
    expect(mockExecuteTest).not.toHaveBeenCalled();
  });

  it("does not test a tool owned by another company", async () => {
    mockToolService.getDefinitionById.mockResolvedValue(toolDefinition({ companyId: OTHER_COMPANY_ID }));
    const mockExecuteTest = vi.fn();

    const res = await request(createApp(undefined, undefined, { executeTest: mockExecuteTest }))
      .post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`)
      .send({ input: {} });

    expect(res.status).toBe(404);
    expect(mockExecuteTest).not.toHaveBeenCalled();
  });
});
