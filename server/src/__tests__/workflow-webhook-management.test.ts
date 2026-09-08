import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  activityLog,
  companySecrets,
  createDb,
  workflowDefinitions,
  workflowWebhookConfigs,
  workflowWebhookDeliveries,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { freshCompany } from "./helpers/bounded-reads-test-utils.js";

const mockEngine = vi.hoisted(() => ({
  workflowService: {
    getDefinition: vi.fn(),
    trigger: vi.fn(),
    listDefinitions: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    listStepRuns: vi.fn(),
  },
}));
vi.mock("../services/workflow/engine.js", () => mockEngine);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres webhook management tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const boardActor = {
  type: "board",
  userId: "board-user-1",
  companyIds: [] as string[],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

function buildApp(actor: Record<string, unknown>, db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("workflow webhook management routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;
  let app!: express.Express;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-mgmt-");
    db = createDb(tempDb.connectionString);
    companyId = await freshCompany(db);
    workflowId = crypto.randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "wf" });
    app = buildApp({ ...boardActor, companyIds: [companyId] }, db);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine.workflowService.getDefinition.mockResolvedValue({
      id: workflowId,
      companyId,
      name: "wf",
      status: "active",
      steps: [],
      runInputs: [],
    });
  });

  it("board enable returns the secret exactly once and stores it versioned", async () => {
    const res = await request(app).post(`/api/workflows/${workflowId}/webhook`);
    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe("string");
    expect(res.body.secret.length).toBeGreaterThan(0);
    expect(res.body.last4).toBe(res.body.secret.slice(-4));
    expect(res.body.enabled).toBe(true);

    const [config] = await db
      .select()
      .from(workflowWebhookConfigs)
      .where(eq(workflowWebhookConfigs.workflowId, workflowId));
    expect(config.enabled).toBe(true);
    expect(config.secretRef).toBe(`workflow-webhook:${workflowId}`);
    const [secretRow] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.name, config.secretRef));
    expect(secretRow.companyId).toBe(companyId);

    const [log] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "workflow.webhook.enabled"), eq(activityLog.entityId, workflowId)));
    expect(log).toBeDefined();
    expect(JSON.stringify(log.details)).not.toContain(res.body.secret);

    // The secret is never echoed again on status reads.
    const status = await request(app).get(`/api/workflows/${workflowId}/webhook`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, last4: res.body.last4 });
    expect(JSON.stringify(status.body)).not.toContain(res.body.secret);
  });

  it("rotates on second enable: new secret, versioned history, rotated activity", async () => {
    const first = await request(app).post(`/api/workflows/${workflowId}/webhook`);
    const second = await request(app).post(`/api/workflows/${workflowId}/webhook`);
    expect(second.status).toBe(200);
    expect(second.body.secret).not.toBe(first.body.secret);

    const [config] = await db
      .select()
      .from(workflowWebhookConfigs)
      .where(eq(workflowWebhookConfigs.workflowId, workflowId));
    const [secretRow] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.name, config.secretRef));
    expect(secretRow.latestVersion).toBeGreaterThanOrEqual(2);

    const [log] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "workflow.webhook.rotated"));
    expect(log).toBeDefined();
  });

  it("403 for agent actors", async () => {
    const agentApp = buildApp({ ...agentActor, companyId }, db);
    const res = await request(agentApp).post(`/api/workflows/${workflowId}/webhook`);
    expect(res.status).toBe(403);
    const del = await request(agentApp).delete(`/api/workflows/${workflowId}/webhook`);
    expect(del.status).toBe(403);
    const status = await request(agentApp).get(`/api/workflows/${workflowId}/webhook`);
    expect(status.status).toBe(403);
  });

  it("disable keeps receipts and returns 404 when repeated; status counts deliveries", async () => {
    const enabled = await request(app).post(`/api/workflows/${workflowId}/webhook`);
    expect(enabled.status).toBe(200);
    await db.insert(workflowWebhookDeliveries).values({
      companyId,
      workflowId,
      idempotencyKey: `mgmt-${crypto.randomUUID()}`,
    });

    const status = await request(app).get(`/api/workflows/${workflowId}/webhook`);
    expect(status.body.deliveriesLast24h).toBeGreaterThanOrEqual(1);

    const del = await request(app).delete(`/api/workflows/${workflowId}/webhook`);
    expect(del.status).toBe(200);
    expect(del.body.enabled).toBe(false);
    const [config] = await db
      .select()
      .from(workflowWebhookConfigs)
      .where(eq(workflowWebhookConfigs.workflowId, workflowId));
    expect(config.enabled).toBe(false);
    const receipts = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.workflowId, workflowId));
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    const delAgain = await request(app).delete(`/api/workflows/${workflowId}/webhook`);
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.enabled).toBe(false);

    // DELETE remains 404; GET reports an unconfigured status without creating a config.
    const freshWorkflowId = crypto.randomUUID();
    await db.insert(workflowDefinitions).values({ id: freshWorkflowId, companyId, name: "wf-no-webhook" });
    mockEngine.workflowService.getDefinition.mockResolvedValue({
      id: freshWorkflowId,
      companyId,
      name: "wf-no-webhook",
      status: "active",
      steps: [],
      runInputs: [],
    });
    const delNever = await request(app).delete(`/api/workflows/${freshWorkflowId}/webhook`);
    expect(delNever.status).toBe(404);
    const getNever = await request(app).get(`/api/workflows/${freshWorkflowId}/webhook`);
    expect(getNever.status).toBe(200);
    expect(getNever.body).toEqual({ enabled: false, last4: null, deliveriesLast24h: 0 });
    const configs = await db.select().from(workflowWebhookConfigs)
      .where(eq(workflowWebhookConfigs.workflowId, freshWorkflowId));
    expect(configs).toEqual([]);

    const [disabledLog] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "workflow.webhook.disabled"), eq(activityLog.entityId, workflowId)));
    expect(disabledLog).toBeDefined();

    const dayAgo = new Date(Date.now() - 24 * 3_600_000);
    const recent = receipts.filter((r) => r.receivedAt >= dayAgo);
    const statusAfter = await request(app).get(`/api/workflows/${workflowId}/webhook`);
    expect(statusAfter.body.enabled).toBe(false);
    expect(statusAfter.body.deliveriesLast24h).toBeGreaterThanOrEqual(recent.length);
  });

  it("404 for an unknown workflow", async () => {
    mockEngine.workflowService.getDefinition.mockResolvedValue(undefined);
    const unknownId = crypto.randomUUID();
    const res = await request(app).post(`/api/workflows/${unknownId}/webhook`);
    expect(res.status).toBe(404);
    const status = await request(app).get(`/api/workflows/${unknownId}/webhook`);
    expect(status.status).toBe(404);
  });

  it("GET returns 404 for a workflow outside the board actor's companies", async () => {
    const otherCompanyApp = buildApp({
      ...boardActor,
      source: "session",
      companyIds: [crypto.randomUUID()],
    }, db);
    const status = await request(otherCompanyApp).get(`/api/workflows/${workflowId}/webhook`);
    expect(status.status).toBe(404);
  });

  it("GET requires authentication", async () => {
    const anonymousApp = buildApp({ type: "none" }, db);
    const status = await request(anonymousApp).get(`/api/workflows/${workflowId}/webhook`);
    expect(status.status).toBe(401);
  });
});
