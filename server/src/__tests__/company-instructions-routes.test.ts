import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyInstructionRoutes } from "../routes/company-instructions.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanyInstructionsService = vi.hoisted(() => ({
  list: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companyInstructionsService: () => mockCompanyInstructionsService,
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companyInstructionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company instruction routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.getById.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockCompanyInstructionsService.list.mockResolvedValue({
      companyId: "company-1",
      rootPath: "/runtime/companies/company-1/instructions",
      files: [{ path: "research-company-common.md", size: 10, language: "markdown", markdown: true, editable: true }],
    });
    mockCompanyInstructionsService.readFile.mockResolvedValue({
      path: "research-company-common.md",
      size: 10,
      language: "markdown",
      markdown: true,
      editable: true,
      content: "# Common",
    });
    mockCompanyInstructionsService.writeFile.mockResolvedValue({
      path: "research-company-common.md",
      size: 10,
      language: "markdown",
      markdown: true,
      editable: true,
      content: "# Common",
    });
    mockCompanyInstructionsService.deleteFile.mockResolvedValue({ path: "research-company-common.md" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists company instruction files for company readers", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    })).get("/api/companies/company-1/instructions");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.files[0].path).toBe("research-company-common.md");
    expect(mockCompanyInstructionsService.list).toHaveBeenCalledWith("company-1");
  });

  it("allows local board operators to update company instruction files", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .put("/api/companies/company-1/instructions/file")
      .send({ path: "research-company-common.md", content: "# Common" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanyInstructionsService.writeFile).toHaveBeenCalledWith(
      "company-1",
      "research-company-common.md",
      "# Common",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.instructions_file_updated",
      details: expect.objectContaining({ path: "research-company-common.md" }),
    }));
  });

  it("blocks same-company agents without management permission from updating company instructions", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .put("/api/companies/company-1/instructions/file")
      .send({ path: "research-company-common.md", content: "# Common" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanyInstructionsService.writeFile).not.toHaveBeenCalled();
  });
});
