/**
 * [purpose] Slice-3 (B): save-time assertion FLOOR — creating or adapterConfig-rewriting
 *   an HTTP tool whose response contract persists an artifact (artifactField/artifactFileName
 *   configured) with ZERO assertions must be rejected with a structured validation error
 *   naming the missing requirement. Garbage tool responses must not become persisted
 *   success artifacts by default.
 * [compat] Floor applies at CREATE and at PATCH only when adapterConfig is present in the
 *   body (registry replaces adapterConfig wholesale). PATCHes without adapterConfig keep
 *   working for legacy artifact tools that predate the floor (read-only exception in report).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
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

const ARTIFACT_RESPONSE = {
  resultField: "result",
  artifactField: "result",
  artifactFileName: "tech-blog-collect.json",
  artifactPathResultField: "rawPath",
};
const ASSERTED_RESPONSE = {
  ...ARTIFACT_RESPONSE,
  assertions: [
    { field: "ok", equals: true },
    { field: "noNewPosts", type: "boolean" },
    { field: "stateToken.version", equals: 1 },
  ],
};

function legacyArtifactTool() {
  return {
    id: TOOL_ID,
    companyId: COMPANY_ID,
    name: "legacy-collect",
    description: "Pre-floor artifact tool with zero assertions",
    inputSchema: {},
    adapterType: "http",
    adapterConfig: { url: "https://example.test/webhook", response: ARTIFACT_RESPONSE },
    enabled: true,
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    updatedAt: new Date("2026-09-03T00:00:00.000Z"),
  };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user-1",
  companyIds: [COMPANY_ID],
  source: "authenticated",
  isInstanceAdmin: false,
}, db: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", toolDefinitionRoutes(db as never, {}));
  app.use(errorHandler);
  return app;
}

function createBody(adapterConfig: Record<string, unknown>, adapterType = "http") {
  return {
    name: `collect-${Math.random().toString(36).slice(2, 8)}`,
    adapterType,
    adapterConfig,
  };
}

describe("tool definition assertion floor (HTTP artifact tools)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockToolService.getDefinitionById.mockResolvedValue(legacyArtifactTool());
    mockToolService.createDefinition.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
      id: "new-tool", ...input, companyId: COMPANY_ID, enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    }));
    mockToolService.updateDefinition.mockResolvedValue(legacyArtifactTool());
  });

  it("rejects CREATE of an HTTP artifact tool with zero assertions (422, names the requirement)", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send(createBody({ url: "https://example.test/webhook", response: ARTIFACT_RESPONSE }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/assertion/i);
    expect(mockToolService.createDefinition).not.toHaveBeenCalled();
  });

  it("accepts CREATE of an HTTP artifact tool WITH assertions", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send(createBody({ url: "https://example.test/webhook", response: ASSERTED_RESPONSE }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockToolService.createDefinition).toHaveBeenCalled();
  });

  it("accepts CREATE of an HTTP tool without an artifact response config (no floor)", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/tools`)
      .send(createBody({ url: "https://example.test/webhook", response: { resultField: "result" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("rejects PATCH that rewrites adapterConfig to artifact-with-zero-assertions", async () => {
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ adapterConfig: { url: "https://example.test/webhook", response: ARTIFACT_RESPONSE } });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/assertion/i);
    expect(mockToolService.updateDefinition).not.toHaveBeenCalled();
  });

  it("accepts PATCH that rewrites adapterConfig WITH assertions", async () => {
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ adapterConfig: { url: "https://example.test/webhook", response: ASSERTED_RESPONSE } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("legacy operability: PATCH without adapterConfig (e.g. enabled) still works on a zero-assertion artifact tool", async () => {
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ enabled: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockToolService.updateDefinition).toHaveBeenCalled();
  });
});
