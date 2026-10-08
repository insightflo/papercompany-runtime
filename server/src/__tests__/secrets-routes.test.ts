import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { secretRoutes } from "../routes/secrets.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_SECRET_ID = "55555555-5555-4555-8555-555555555555";

const mockSecretService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
}));

const mockToolService = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  secretService: vi.fn(() => mockSecretService),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/tools/registry.js", () => ({
  toolService: mockToolService,
}));

const { logActivity } = await import("../services/index.js");

function secret(overrides: Record<string, unknown> = {}) {
  return {
    id: SECRET_ID,
    companyId: COMPANY_ID,
    name: "alpha-token",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 1,
    description: null,
    createdByAgentId: null,
    createdByUserId: "board-user-1",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

function tool(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    companyId: COMPANY_ID,
    name: "daily-tech-scout",
    description: "Collect daily AI and tech signals.",
    inputSchema: { type: "object" },
    adapterType: "http",
    adapterConfig: {
      url: "https://example.test/hooks",
      auth: { headerName: "Authorization", secretId: SECRET_ID, version: "latest" },
    },
    enabled: true,
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T01:00:00.000Z"),
    ...overrides,
  };
}

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "board-user-1",
    companyIds: [COMPANY_ID],
    source: "authenticated",
    isInstanceAdmin: false,
  },
  db: unknown = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", secretRoutes(db as never));
  app.use(errorHandler);
  return app;
}

describe("secret routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToolService.listDefinitions.mockResolvedValue([]);
  });

  it("lists secrets with usedByTools from referencing tools", async () => {
    mockSecretService.list.mockResolvedValue([
      secret(),
      secret({ id: OTHER_SECRET_ID, name: "unused-token" }),
    ]);
    mockToolService.listDefinitions.mockResolvedValue([
      tool({ name: "daily-tech-scout" }),
      tool({ name: "market-pulse", adapterConfig: { auth: { headerName: "X-Api-Key", secretId: SECRET_ID } } }),
      tool({ name: "no-auth-tool", adapterConfig: { url: "https://example.test/plain" } }),
    ]);

    const res = await request(createApp()).get(`/api/companies/${COMPANY_ID}/secrets`);

    expect(res.status).toBe(200);
    expect(mockToolService.listDefinitions).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY_ID });
    const alpha = res.body.find((item: { name: string }) => item.name === "alpha-token");
    const unused = res.body.find((item: { name: string }) => item.name === "unused-token");
    expect(alpha.usedByTools).toEqual(["daily-tech-scout", "market-pulse"]);
    expect(unused.usedByTools).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("material");
  });

  it("blocks delete with 409 and usedByTools when a tool references the secret", async () => {
    mockSecretService.getById.mockResolvedValue(secret());
    mockSecretService.remove.mockResolvedValue(secret());
    mockToolService.listDefinitions.mockResolvedValue([tool({ name: "daily-tech-scout" })]);

    const res = await request(createApp()).delete(`/api/secrets/${SECRET_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.usedByTools).toEqual(["daily-tech-scout"]);
    expect(res.body.error).toContain("daily-tech-scout");
    expect(mockSecretService.remove).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced secret and logs activity", async () => {
    mockSecretService.getById.mockResolvedValue(secret());
    mockSecretService.remove.mockResolvedValue(secret());

    const res = await request(createApp()).delete(`/api/secrets/${SECRET_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSecretService.remove).toHaveBeenCalledWith(SECRET_ID);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "secret.deleted", entityId: SECRET_ID }),
    );
  });

  it("rotates a secret and returns the bumped latestVersion", async () => {
    mockSecretService.getById.mockResolvedValue(secret());
    mockSecretService.rotate.mockResolvedValue(secret({ latestVersion: 2 }));

    const res = await request(createApp())
      .post(`/api/secrets/${SECRET_ID}/rotate`)
      .send({ value: "rotated-value-2" });

    expect(res.status).toBe(200);
    expect(res.body.latestVersion).toBe(2);
    expect(mockSecretService.rotate).toHaveBeenCalledWith(
      SECRET_ID,
      { value: "rotated-value-2", externalRef: undefined },
      expect.anything(),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "secret.rotated", details: { version: 2 } }),
    );
  });

  it("keeps company scoping for cross-company board access", async () => {
    const res = await request(createApp()).get(`/api/companies/${OTHER_COMPANY_ID}/secrets`);

    expect(res.status).toBe(403);
    expect(mockSecretService.list).not.toHaveBeenCalled();
  });
});
