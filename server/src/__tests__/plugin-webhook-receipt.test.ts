import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  createDb,
  pluginWebhookDeliveries,
  plugins,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { extractExternalId } from "../services/plugin-webhook-receipt.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: {} }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/work-products.js", () => ({ workProductService: () => ({}) }));
vi.mock("../services/workflow/dag-engine.js", () => ({
  completeWorkflowToolStepFromResult: vi.fn(),
}));

const PLUGIN_ID = "7b7d8a44-2f0f-4d92-9d92-6a83c0d10001";
const OTHER_PLUGIN_ID = "7b7d8a44-2f0f-4d92-9d92-6a83c0d10002";

function readyPluginFixture(id: string, endpointKeys: string[], capabilities: string[] = ["webhooks.receive"]) {
  return {
    id,
    pluginKey: `test.${id.slice(-4)}`,
    packageName: `@test/${id.slice(-4)}`,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: {
      id: `test.${id.slice(-4)}`,
      apiVersion: 1,
      version: "1.0.0",
      capabilities,
      webhooks: endpointKeys.map((endpointKey) => ({ endpointKey })),
    },
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("plugin webhook receipt deduplication", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-receipt-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values(readyPluginFixture(PLUGIN_ID, ["events", "alerts"]));
    await db.insert(plugins).values(readyPluginFixture(OTHER_PLUGIN_ID, ["events"]));
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRegistry.getById.mockImplementation(async (id: string) => {
      if (id === PLUGIN_ID) return readyPluginFixture(PLUGIN_ID, ["events", "alerts"]);
      if (id === OTHER_PLUGIN_ID) return readyPluginFixture(OTHER_PLUGIN_ID, ["events"]);
      return null;
    });
    await db.delete(pluginWebhookDeliveries);
  });

  function createApp(workerCall: ReturnType<typeof vi.fn>) {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      pluginRoutes(db, {} as never, undefined, {
        workerManager: { call: workerCall } as never,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const post = (app: ReturnType<typeof createApp>, pluginId: string, key: string, body: unknown, deliveryHeader?: string) =>
    request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${key}`)
      .set(deliveryHeader ? { "x-delivery-id": deliveryHeader } : {})
      .send(body as Record<string, unknown>);

  it("(a) same externalId twice dispatches the worker once and answers duplicate", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    const first = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-1");
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("success");

    const second = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-1");
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
    expect(second.body.deliveryId).toBe(first.body.deliveryId);

    expect(call).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.externalId, "D-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
  });

  it("(b) deliveries without externalId are all processed (legacy)", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    const first = await post(app, PLUGIN_ID, "events", { foo: 1 });
    const second = await post(app, PLUGIN_ID, "events", { foo: 1 });
    expect(first.body.status).toBe("success");
    expect(second.body.status).toBe("success");
    expect(second.body.deliveryId).not.toBe(first.body.deliveryId);
    expect(call).toHaveBeenCalledTimes(2);

    const rows = await db.select().from(pluginWebhookDeliveries);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.externalId === null)).toBe(true);
  });

  it("(c) failed receipt is reused and redispatched once on provider retry", async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error("worker exploded"))
      .mockResolvedValue({});
    const app = createApp(call);

    const first = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-2");
    expect(first.status).toBe(502);
    expect(first.body.status).toBe("failed");
    expect(first.body.error).toBe("worker exploded");

    const retry = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-2");
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("success");
    expect(retry.body.deliveryId).toBe(first.body.deliveryId);

    expect(call).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.externalId, "D-2"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].error).toBeNull();
  });

  it("(d) same externalId across endpoint keys and plugins is independent", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    const r1 = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-shared");
    const r2 = await post(app, PLUGIN_ID, "alerts", { foo: 1 }, "D-shared");
    const r3 = await post(app, OTHER_PLUGIN_ID, "events", { foo: 1 }, "D-shared");

    expect(r1.body.status).toBe("success");
    expect(r2.body.status).toBe("success");
    expect(r3.body.status).toBe("success");
    expect(call).toHaveBeenCalledTimes(3);

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.externalId, "D-shared"));
    expect(rows).toHaveLength(3);
  });

  it("(e) concurrent arrivals with same externalId dispatch once", async () => {
    const call = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {};
    });
    const app = createApp(call);

    const [r1, r2] = await Promise.all([
      post(app, PLUGIN_ID, "events", { foo: 1 }, "D-race"),
      post(app, PLUGIN_ID, "events", { foo: 1 }, "D-race"),
    ]);

    const statuses = [r1.body.status, r2.body.status].sort();
    expect(statuses).toEqual(["duplicate", "success"]);
    expect(r1.body.deliveryId).toBe(r2.body.deliveryId);
    expect(call).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.externalId, "D-race"));
    expect(rows).toHaveLength(1);
  });

  it("(f) payload deliveryId is extracted when headers are absent", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    const first = await post(app, PLUGIN_ID, "events", { deliveryId: "payload-1" });
    const second = await post(app, PLUGIN_ID, "events", { deliveryId: "payload-1" });
    expect(first.body.status).toBe("success");
    expect(second.body.status).toBe("duplicate");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("(g) stale pending receipt is taken over and redispatched", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    // Simulate a receipt abandoned mid-dispatch (e.g. server crash).
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000);
    const [stale] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: PLUGIN_ID,
        webhookKey: "events",
        externalId: "D-stale",
        status: "pending",
        payload: {},
        headers: {},
        startedAt: staleStartedAt,
      })
      .returning({ id: pluginWebhookDeliveries.id });

    const res = await post(app, PLUGIN_ID, "events", { foo: 1 }, "D-stale");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.deliveryId).toBe(stale.id);

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.externalId, "D-stale"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
  });

  it("(f-regression) validation failures keep existing contract", async () => {
    const call = vi.fn(async () => ({}));
    const app = createApp(call);

    const unknownPlugin = await post(app, "11111111-2222-4333-8444-555555555555", "events", { foo: 1 });
    expect(unknownPlugin.status).toBe(404);

    const unknownKey = await post(app, PLUGIN_ID, "not-declared", { foo: 1 });
    expect(unknownKey.status).toBe(404);

    mockRegistry.getById.mockResolvedValueOnce(readyPluginFixture(PLUGIN_ID, ["events"], ["tools.execute"]));
    const noCapability = await post(app, PLUGIN_ID, "events", { foo: 1 });
    expect(noCapability.status).toBe(400);

    expect(call).not.toHaveBeenCalled();
    const rows = await db.select().from(pluginWebhookDeliveries);
    expect(rows).toHaveLength(0);
  });
});

describe("extractExternalId", () => {
  it("prefers x-delivery-id over x-webhook-id and payload", () => {
    expect(
      extractExternalId({ "x-delivery-id": "header-1", "x-webhook-id": "header-2" }, { deliveryId: "payload-1" }),
    ).toBe("header-1");
  });

  it("uses x-webhook-id when x-delivery-id is absent", () => {
    expect(extractExternalId({ "x-webhook-id": "header-2" }, {})).toBe("header-2");
  });

  it("uses payload deliveryId when headers carry nothing", () => {
    expect(extractExternalId({}, { deliveryId: "payload-1" })).toBe("payload-1");
    expect(extractExternalId({}, { deliveryId: 42 })).toBe("42");
  });

  it("returns null when no source yields a usable identifier", () => {
    expect(extractExternalId({}, {})).toBeNull();
    expect(extractExternalId({ "x-delivery-id": "   " }, { deliveryId: "" })).toBeNull();
    expect(extractExternalId({}, { deliveryId: { nested: true } })).toBeNull();
    expect(extractExternalId({}, { deliveryId: "x".repeat(513) })).toBeNull();
  });
});
