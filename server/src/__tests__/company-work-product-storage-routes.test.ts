import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyWorkProductStorageRoutes } from "../routes/company-work-product-storage.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const companyId = "company-1";
const s3Config = {
  provider: "s3" as const,
  endpoint: "https://storage.example.test",
  region: "us-east-1",
  bucket: "company-work-products",
  keyPrefix: "outputs/",
  forcePathStyle: true,
  accessKeySecretId: "00000000-0000-4000-8000-000000000001",
  secretAccessKeySecretId: "00000000-0000-4000-8000-000000000002",
};

function createFakeService() {
  return {
    get: vi.fn().mockResolvedValue({ provider: "local_disk" }),
    save: vi.fn().mockImplementation(async (_companyId: string, config: typeof s3Config) => config),
    testConnection: vi.fn().mockResolvedValue({
      provider: "s3",
      ok: true,
    }),
  };
}

function createApp(actor: Record<string, unknown>, service = createFakeService()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companyWorkProductStorageRoutes({} as any, { service: service as any }));
  app.use(errorHandler);
  return { app, service };
}

function boardActor(companyIds = [companyId]) {
  return {
    type: "board",
    userId: "board-1",
    companyIds,
    source: "session",
    isInstanceAdmin: false,
  };
}

describe("company work-product storage routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns the visible default local storage configuration to a board user", async () => {
    const { app, service } = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${companyId}/work-product-storage`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ provider: "local_disk" });
    expect(service.get).toHaveBeenCalledWith(companyId);
  });

  it("saves strict S3 storage configuration and records only its provider", async () => {
    const { app, service } = createApp(boardActor());

    const res = await request(app)
      .put(`/api/companies/${companyId}/work-product-storage`)
      .send(s3Config);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(s3Config);
    expect(service.save).toHaveBeenCalledWith(companyId, s3Config);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "work_product_storage.updated",
      entityType: "work_product_storage",
      entityId: companyId,
      details: { provider: "s3" },
    }));
  });

  it("returns a safe connection result and logs only provider and outcome", async () => {
    const { app, service } = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/work-product-storage/test`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ provider: "s3", ok: true });
    expect(service.testConnection).toHaveBeenCalledWith(companyId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "work_product_storage.connection_tested",
      entityType: "work_product_storage",
      entityId: companyId,
      details: { provider: "s3", ok: true },
    }));
  });

  it("rejects raw access keys and connection-test request bodies", async () => {
    const { app, service } = createApp(boardActor());

    const saveRes = await request(app)
      .put(`/api/companies/${companyId}/work-product-storage`)
      .send({ ...s3Config, accessKey: "raw-access-key" });
    const testRes = await request(app)
      .post(`/api/companies/${companyId}/work-product-storage/test`)
      .send({ secretAccessKey: "raw-secret" });

    expect(saveRes.status).toBe(400);
    expect(testRes.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.testConnection).not.toHaveBeenCalled();
  });

  it("rejects agents and board users without company access", async () => {
    const agent = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const outsider = createApp(boardActor(["company-2"]));

    const [agentRes, outsiderRes] = await Promise.all([
      request(agent.app).get(`/api/companies/${companyId}/work-product-storage`),
      request(outsider.app).get(`/api/companies/${companyId}/work-product-storage`),
    ]);

    expect(agentRes.status).toBe(403);
    expect(outsiderRes.status).toBe(403);
    expect(agent.service.get).not.toHaveBeenCalled();
    expect(outsider.service.get).not.toHaveBeenCalled();
  });
});
