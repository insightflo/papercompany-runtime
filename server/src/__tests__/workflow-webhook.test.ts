import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  createDb,
  workflowDefinitions,
  workflowWebhookConfigs,
  workflowWebhookDeliveries,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { secretService } from "../services/secrets.js";
import { workflowWebhookRoutes, webhookRawBodyErrorHandler } from "../routes/workflow-webhooks.js";
import { WorkflowRunInputValidationError } from "../services/workflow/run-input-normalization.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { freshCompany } from "./helpers/bounded-reads-test-utils.js";

const mockEngine = vi.hoisted(() => ({
  workflowService: {
    getDefinition: vi.fn(),
    trigger: vi.fn(),
  },
}));
vi.mock("../services/workflow/engine.js", () => mockEngine);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres webhook route tests: ${embeddedPostgresSupport.supported ? "" : embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

const QUOTA = { max: 60, windowMs: 3_600_000 };

function sign(secret: string, timestamp: string, rawBody: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

describeEmbeddedPostgres("workflow webhook route (POST /api/webhooks/workflows/:workflowId)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;
  let secretValue!: string;
  let app!: express.Express;

  const definition = () => ({
    id: workflowId,
    companyId,
    name: "wf",
    status: "active",
    steps: [],
    runInputs: [] as unknown[],
  });
  let lastRunId = "";
  const mockedRunId = () => {
    lastRunId = crypto.randomUUID();
    return lastRunId;
  };

  const post = (body: string, headers: Record<string, string> = {}) =>
    request(app)
      .post(`/api/webhooks/workflows/${workflowId}`)
      .set("Content-Type", "application/json")
      .set(headers)
      .send(body);

  const signedPost = (
    body: string,
    opts: { ts?: string; key?: string; sig?: string; omit?: string[] } = {},
  ) => {
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "X-Timestamp": ts,
      "X-Idempotency-Key": opts.key ?? `idem-${crypto.randomUUID()}`,
      "X-Signature": opts.sig ?? sign(secretValue, ts, body),
    };
    for (const header of opts.omit ?? []) delete headers[header];
    return post(body, headers);
  };

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-webhook-route-");
    db = createDb(tempDb.connectionString);
    companyId = await freshCompany(db);
    workflowId = crypto.randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "wf" });
    const secrets = secretService(db);
    await secrets.create(companyId, {
      name: `workflow-webhook:${workflowId}`,
      provider: "local_encrypted",
      value: secretValue = "route-secret-v1",
    });
    await db.insert(workflowWebhookConfigs).values({
      companyId,
      workflowId,
      secretRef: `workflow-webhook:${workflowId}`,
      enabled: true,
      secretLast4: "t-v1",
    });
    app = express();
    app.use(
      "/api/webhooks/workflows",
      express.raw({ limit: "64kb", type: "application/json" }),
      webhookRawBodyErrorHandler,
    );
    app.use("/api", workflowWebhookRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockEngine.workflowService.getDefinition.mockResolvedValue(definition());
    mockEngine.workflowService.trigger.mockImplementation(async () => ({
      runId: mockedRunId(),
      workflowId,
      missionId: null,
      status: "running",
      completedAt: null,
      stepRuns: [],
    }));
  });

  it("accepts a signed delivery: 202, run created with triggerSource webhook + metadata, receipt bound, activity logged", async () => {
    const payload = JSON.stringify({ topic: "release", url: "https://example.com/v" });
    const res = await signedPost(payload, { key: "happy-key-1" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: lastRunId, idempotencyKey: "happy-key-1" });
    // [care] 전체 호출 비교 금지(첫 인자 DB 포함, 실패 시 diff 포맷 OOM 위험).
    // 3-인자 계약(원본 payload + 레거시 웹훅 정책)을 경계 projection으로 단언한다.
    expect(mockEngine.workflowService.trigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockEngine.workflowService.trigger.mock.calls[0]!;
    expect(triggerCall.length).toBe(3);
    expect(triggerCall[0] === db).toBe(true);
    expect(triggerCall[1]).toMatchObject({
      workflowId,
      companyId,
      triggerSource: "webhook",
      triggeredBy: "webhook",
    });
    expect(triggerCall[1].metadata).toEqual({ topic: "release", url: "https://example.com/v" });
    expect(triggerCall[2]).toEqual({ legacyTextRequired: true });
    const [delivery] = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "happy-key-1"));
    expect(delivery.runId).toBe(lastRunId);
    const logs = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, lastRunId), eq(activityLog.action, "workflow_run.created")));
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ triggerSource: "webhook", idempotencyKey: "happy-key-1" });
  });

  it("replays the same idempotency key to the same runId without a second run", async () => {
    const payload = JSON.stringify({ topic: "replay" });
    const first = await signedPost(payload, { key: "replay-key-1" });
    expect(first.status).toBe(202);
    const firstRunId = lastRunId;
    const second = await signedPost(payload, { key: "replay-key-1" });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ runId: firstRunId, idempotencyKey: "replay-key-1" });
    expect(mockEngine.workflowService.trigger).toHaveBeenCalledTimes(1);
  });

  it("404 for an unknown workflow", async () => {
    mockEngine.workflowService.getDefinition.mockResolvedValue(undefined);
    const res = await signedPost("{}");
    expect(res.status).toBe(404);
  });

  it("409 when the webhook is disabled or the definition is not active", async () => {
    await db
      .update(workflowWebhookConfigs)
      .set({ enabled: false })
      .where(eq(workflowWebhookConfigs.workflowId, workflowId));
    expect((await signedPost("{}")).status).toBe(409);
    await db
      .update(workflowWebhookConfigs)
      .set({ enabled: true })
      .where(eq(workflowWebhookConfigs.workflowId, workflowId));
    mockEngine.workflowService.getDefinition.mockResolvedValue({ ...definition(), status: "archived" });
    expect((await signedPost("{}")).status).toBe(409);
  });

  it("401 for a wrong signature or a stale timestamp", async () => {
    expect((await signedPost("{}", { sig: "00".repeat(32) })).status).toBe(401);
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const res = await signedPost("{}", { ts: staleTs });
    expect(res.status).toBe(401);
  });

  it("413 when the raw body exceeds 64KiB", async () => {
    const big = JSON.stringify({ pad: "x".repeat(70_000) });
    const res = await signedPost(big);
    expect(res.status).toBe(413);
  });

  it("415 for a non-JSON content type", async () => {
    const res = await request(app)
      .post(`/api/webhooks/workflows/${workflowId}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
  });

  it("400 for invalid JSON, non-object JSON, and missing headers", async () => {
    expect((await signedPost("{not json")).status).toBe(400);
    expect((await signedPost("[1,2,3]")).status).toBe(400);
    expect((await signedPost("{}", { omit: ["X-Timestamp"] })).status).toBe(400);
    expect((await signedPost("{}", { omit: ["X-Idempotency-Key"] })).status).toBe(400);
    expect((await signedPost("{}", { key: "k".repeat(201) })).status).toBe(400);
    expect((await signedPost("{}", { omit: ["X-Signature"] })).status).toBe(400);
  });

  it("translates a typed engine run-input error into 400 and forwards the legacy webhook policy; ok when values provided", async () => {
    // [care] 필수 검사는 라우트 프리플라이트에서 엔진 정규화 경계로 이동했다. 엔진은 모의이므로
    // 이 파일에서는 타입핑 에러 번역(400 + 구조화 details, receipt runId 없음)과 정책 전달만 검증한다.
    mockEngine.workflowService.getDefinition.mockResolvedValue({
      ...definition(),
      runInputs: [{ key: "topic", label: "Topic", required: true }],
    });
    mockEngine.workflowService.trigger.mockRejectedValueOnce(
      new WorkflowRunInputValidationError([{ key: "topic", code: "required", message: "'Topic' 항목은 필수 입력입니다." }]),
    );

    const rejected = await signedPost(JSON.stringify({ url: "x" }), { key: "typed-required-key-1" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.details).toEqual({
      version: 1,
      code: "invalid_workflow_run_inputs",
      fieldErrors: [{ key: "topic", code: "required", message: "'Topic' 항목은 필수 입력입니다." }],
    });
    expect(mockEngine.workflowService.trigger).toHaveBeenCalledTimes(1);
    const rejectedCall = mockEngine.workflowService.trigger.mock.calls[0]!;
    expect(rejectedCall.length).toBe(3);
    expect(rejectedCall[2]).toEqual({ legacyTextRequired: true });
    const [rejectedDelivery] = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "typed-required-key-1"));
    expect(rejectedDelivery?.runId ?? null).toBeNull();

    const ok = await signedPost(JSON.stringify({ topic: "release", url: "x" }), { key: "typed-required-key-2" });
    expect(ok.status).toBe(202);
    expect(mockEngine.workflowService.trigger).toHaveBeenCalledTimes(2);
    const okCall = mockEngine.workflowService.trigger.mock.calls[1]!;
    expect(okCall[1].metadata).toEqual({ topic: "release", url: "x" });
    expect(okCall[2]).toEqual({ legacyTextRequired: true });
  });

  it("429 when the workflow admission quota is exhausted", async () => {
    for (let i = 0; i < 60; i++) {
      await db.insert(workflowWebhookDeliveries).values({
        companyId,
        workflowId,
        idempotencyKey: `quota-${workflowId}-${i}`,
      });
    }
    const res = await signedPost("{}");
    expect(res.status).toBe(429);
    expect(mockEngine.workflowService.trigger).not.toHaveBeenCalled();
  });
});
