import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { companyDataStorageRoutes } from "../routes/company-data-storage.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const s3Config = {
  provider: "s3" as const,
  endpoint: "https://storage.example.test",
  region: "us-east-1",
  bucket: "company-shared-data",
  keyPrefix: "gazua",
  forcePathStyle: true,
  accessKeySecretId: "00000000-0000-4000-8000-000000000001",
  secretAccessKeySecretId: "00000000-0000-4000-8000-000000000002",
};

function streamFrom(text: string) {
  return Readable.from(Buffer.from(text));
}

function createFakeStorageService() {
  return {
    get: vi.fn().mockResolvedValue({ provider: "local_disk" }),
    save: vi.fn().mockImplementation(async (_companyId: string, config: typeof s3Config) => config),
    testConnection: vi.fn().mockResolvedValue({ provider: "s3", ok: true }),
    resolveActive: vi.fn().mockResolvedValue({ provider: "local_disk" }),
  };
}

function createFakeObjectService() {
  return {
    listObjects: vi.fn().mockResolvedValue({
      objects: [{ key: "macro/latest.json", size: 10, contentType: "application/json" }],
      truncated: false,
    }),
    readObject: vi.fn().mockResolvedValue({
      stream: streamFrom('{"ok":true}'),
      size: 11,
      contentType: "application/json",
      etag: '"abc"',
      lastModified: "2026-07-16T00:00:00.000Z",
    }),
    writeObject: vi.fn().mockResolvedValue({
      key: "macro/latest.json", size: 11, contentType: "application/json",
      etag: '"abc"', lastModified: "2026-07-16T00:00:00.000Z",
    }),
  };
}

function createApp(actor: Record<string, unknown>, storage = createFakeStorageService(), objects = createFakeObjectService()) {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companyDataStorageRoutes({} as any, { storageService: storage as any, objectService: objects as any }));
  app.use(errorHandler);
  return { app, storage, objects };
}

function boardActor(companyIds = [companyId]) {
  return { type: "board", userId: "board-1", companyIds, source: "session", isInstanceAdmin: false };
}

function agentActor(cid = companyId) {
  return { type: "agent", agentId: "agent-1", companyId: cid, source: "agent_key" };
}

describe("company data storage config routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns the visible default local storage configuration to a board user", async () => {
    const { app, storage } = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/data-storage`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ provider: "local_disk" });
    expect(storage.get).toHaveBeenCalledWith(companyId);
  });

  it("saves strict S3 storage configuration and records only its provider", async () => {
    const { app, storage } = createApp(boardActor());
    const res = await request(app).put(`/api/companies/${companyId}/data-storage`).send(s3Config);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(s3Config);
    expect(storage.save).toHaveBeenCalledWith(companyId, s3Config);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId, action: "data_storage.updated", entityType: "data_storage",
      entityId: companyId, details: { provider: "s3" },
    }));
  });

  it("returns a safe connection result and logs only provider and outcome", async () => {
    const { app, storage } = createApp(boardActor());
    const res = await request(app).post(`/api/companies/${companyId}/data-storage/test`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ provider: "s3", ok: true });
    expect(storage.testConnection).toHaveBeenCalledWith(companyId);
  });

  it("rejects raw access keys and connection-test request bodies", async () => {
    const { app, storage } = createApp(boardActor());
    const saveRes = await request(app).put(`/api/companies/${companyId}/data-storage`).send({ ...s3Config, accessKey: "raw-access-key" });
    const testRes = await request(app)
      .post(`/api/companies/${companyId}/data-storage/test`)
      .set("Content-Type", "application/json")
      .send({ secretAccessKey: "raw-secret" });
    const unsafePrefixRes = await request(app)
      .put(`/api/companies/${companyId}/data-storage`)
      .send({ ...s3Config, keyPrefix: "../other-company" });
    expect(saveRes.status).toBe(400);
    expect(testRes.status).toBe(400);
    expect(unsafePrefixRes.status).toBe(400);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.testConnection).not.toHaveBeenCalled();
  });

  it("rejects agents and board users without company access for config", async () => {
    const agent = createApp(agentActor());
    const outsider = createApp(boardActor([otherCompanyId]));
    const [agentRes, outsiderRes] = await Promise.all([
      request(agent.app).get(`/api/companies/${companyId}/data-storage`),
      request(outsider.app).get(`/api/companies/${companyId}/data-storage`),
    ]);
    expect(agentRes.status).toBe(403);
    expect(outsiderRes.status).toBe(403);
  });
});

describe("company data object routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets a company agent list objects by prefix relative to the configured root", async () => {
    const { app, objects } = createApp(agentActor());
    const res = await request(app).get(`/api/companies/${companyId}/data/objects?prefix=macro`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(objects.listObjects).toHaveBeenCalledWith(companyId, { prefix: "macro", limit: 1000 });
    expect(res.body.objects[0].key).toBe("macro/latest.json");
  });

  it("lets a company agent read (download) an object by key with metadata headers", async () => {
    const { app, objects } = createApp(agentActor());
    const res = await request(app).get(`/api/companies/${companyId}/data/objects?key=macro/latest.json`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"ok":true}');
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-papercompany-key"]).toBe("macro/latest.json");
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers["content-disposition"]).toBe("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(objects.readObject).toHaveBeenCalledWith(companyId, "macro/latest.json");
  });

  it("forces active HTML downloads to attachment/octet-stream with nosniff", async () => {
    const { app, objects } = createApp(agentActor());
    const html = "<script>alert(1)</script>";
    objects.readObject.mockResolvedValueOnce({
      stream: streamFrom(html),
      size: Buffer.byteLength(html),
      contentType: "text/html; charset=utf-8",
      etag: '"html"',
      lastModified: "2026-07-16T00:00:00.000Z",
    });

    const res = await request(app).get(
      `/api/companies/${companyId}/data/objects?key=reports/latest.html`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects encoded traversal in company IDs and object keys before service access", async () => {
    const { app, objects } = createApp(agentActor());
    const encodedCompanyId = encodeURIComponent(`../${companyId}`);
    const companyRes = await request(app).get(
      `/api/companies/${encodedCompanyId}/data/objects`,
    );
    const encodedKey = encodeURIComponent("../escape.json");
    const keyRes = await request(app).get(
      `/api/companies/${companyId}/data/objects?key=${encodedKey}`,
    );

    expect(companyRes.status).toBe(400);
    expect(keyRes.status).toBe(400);
    expect(objects.readObject).not.toHaveBeenCalled();
  });

  it("lets a company agent write an object using the raw body", async () => {
    const { app, objects } = createApp(agentActor());
    const res = await request(app)
      .put(`/api/companies/${companyId}/data/objects?key=macro/latest.json`)
      .set("Content-Type", "application/json")
      .send('{"v":2}');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.key).toBe("macro/latest.json");
    expect(objects.writeObject).toHaveBeenCalledWith(
      companyId, "macro/latest.json", expect.any(Buffer), "application/json",
    );
    expect((objects.writeObject.mock.calls[0][2] as Buffer).toString()).toBe('{"v":2}');
  });

  it("accepts a non-JSON raw object without changing its bytes", async () => {
    const { app, objects } = createApp(agentActor());
    const csv = "date,value\n2026-07-16,1\n";
    const res = await request(app)
      .put(`/api/companies/${companyId}/data/objects?key=macro/history/sample.csv`)
      .set("Content-Type", "text/csv")
      .send(csv);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(objects.writeObject).toHaveBeenCalledWith(
      companyId, "macro/history/sample.csv", expect.any(Buffer), "text/csv",
    );
    expect((objects.writeObject.mock.calls[0][2] as Buffer).toString()).toBe(csv);
  });

  it("requires a key query parameter for writes", async () => {
    const { app } = createApp(boardActor());
    const res = await request(app).put(`/api/companies/${companyId}/data/objects`).send('{"v":2}');
    expect(res.status).toBe(400);
  });

  it("blocks agents of a different company from the object API", async () => {
    const outsider = createApp(agentActor(otherCompanyId));
    const listRes = await request(outsider.app).get(`/api/companies/${companyId}/data/objects`);
    const readRes = await request(outsider.app).get(`/api/companies/${companyId}/data/objects?key=macro/latest.json`);
    expect(listRes.status).toBe(403);
    expect(readRes.status).toBe(403);
    expect(outsider.objects.listObjects).not.toHaveBeenCalled();
  });
});
