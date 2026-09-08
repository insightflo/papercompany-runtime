import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, createDb, workflowRuns, workflowWebhookDeliveries } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildBoardApp,
  invalidInputDetails,
  legacyTextFields,
  manualFields,
  seedWebhookFixture,
  signedWebhookJson,
  webhookDeliveriesByKey,
  webhookFields,
} from "./helpers/workflow-run-input-http-fixture.js";
import {
  countCompanyRunState,
  seedRunInputWorkflow,
} from "./helpers/workflow-run-input-fixture.js";
import { workflowService } from "../services/workflow/engine.js";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";

// workflow-manual-run-mission-label.test.ts와 동일한 wakeup-mock 경계. 실제 엔진·미션
// 서비스·스토어·Drizzle·DAG 이슈 생성을 쓰고 외부 heartbeat/assignment wakeup만 부분 mock.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping workflow run input HTTP tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEP("workflow run input HTTP boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 21).toString("base64"));
    tempDb = await startEmbeddedPostgresTestDatabase("wf-run-input-http-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    heartbeatWakeup.mockReset();
    heartbeatWakeup.mockResolvedValue({ id: "test-wakeup" });
  });

  afterAll(async () => {
    try { await db?.$client.end({ timeout: 5 }); }
    finally { vi.unstubAllEnvs(); await tempDb?.cleanup(); }
  });

  it("round-trips typed runInputs through engine create/get and keeps them on partial updates", async () => {
    const seed = await seedRunInputWorkflow(db, []);
    const declared: WorkflowRunInput[] = [
      ...manualFields.map((field) => field.type === "switch" ? { ...field, default: true } : field),
      { key: "url", type: "text", required: false, placeholder: "https://youtu.be/dQw4w9WgXcQ" },
      { key: "videoId", type: "text", required: false, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const created = await workflowService.createDefinition(db, {
      companyId: seed.companyId,
      name: "typed-round-trip",
      status: "active",
      steps: [{ id: "collect", name: "Collect", agentId: seed.agentId, dependencies: [] }],
      runInputs: declared,
    });
    expect(created.runInputs).toEqual(declared);
    expect((await workflowService.getDefinition(db, created.id))?.runInputs).toEqual(declared);

    await workflowService.updateDefinition(db, created.id, {
      name: "typed-round-trip-renamed",
      legacyMetadata: { note: "kept" },
    });
    const afterEnginePatch = await workflowService.getDefinition(db, created.id);
    expect(afterEnginePatch?.runInputs).toEqual(declared);
    expect(afterEnginePatch?.legacyMetadata).toEqual({ note: "kept" });

    // UI가 보내는 것과 동일한 runInputs 없는 부분 PATCH도 JSONB를 보존한다(6C.2 짝).
    const app = buildBoardApp(db, seed.companyId);
    const patch = await request(app)
      .patch(`/api/workflows/${created.id}`)
      .send({ name: "typed-round-trip-http", legacyMetadata: { note: "kept2" } });
    expect(patch.status).toBe(200);
    const read = await request(app).get(`/api/workflows/${created.id}`);
    expect(read.status).toBe(200);
    expect(read.body.runInputs).toEqual(declared);
  });

  it("manual POST with omitted radio default applies it and stores typed metadata with top-level runLabel", async () => {
    const seed = await seedRunInputWorkflow(db, manualFields);
    const app = buildBoardApp(db, seed.companyId);
    const res = await request(app)
      .post(`/api/workflows/${seed.workflowId}/runs`)
      .send({ runLabel: "검증", metadata: { enabled: false, tags: [], untouched: 17 } });
    expect(res.status).toBe(201);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, res.body.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({
      section: "manuals",
      enabled: false,
      tags: [],
      untouched: 17,
    }));
    expect(stored!.runLabel).toBe("검증");
    expect(stored!.metadata).not.toHaveProperty("runLabel");
  });

  it.each([
    ["null radio value", { section: null }, "section", "invalid_type"],
    ["unknown radio selection", { section: "bogus" }, "section", "invalid_option"],
    ["non-boolean switch", { enabled: "yes" }, "enabled", "invalid_type"],
    ["duplicate checkbox values", { tags: ["a", "a"] }, "tags", "duplicate_value"],
  ])("manual POST with %s returns structured 400 and writes nothing", async (_label, metadata, key, code) => {
    const seed = await seedRunInputWorkflow(db, manualFields);
    const app = buildBoardApp(db, seed.companyId);
    const before = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    const res = await request(app)
      .post(`/api/workflows/${seed.workflowId}/runs`)
      .send({ metadata });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow run input values");
    expect(res.body.details).toEqual(invalidInputDetails([{ key, code, message: expect.any(String) }]));
    const after = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
  });

  it("still accepts a manual POST omitting required plain text (no new manual text gate)", async () => {
    const seed = await seedRunInputWorkflow(db, [...manualFields, { key: "topic", type: "text", required: true }]);
    const app = buildBoardApp(db, seed.companyId);
    const res = await request(app)
      .post(`/api/workflows/${seed.workflowId}/runs`)
      .send({ metadata: { enabled: true } });
    expect(res.status).toBe(201);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, res.body.runId));
    expect(stored!.metadata).not.toHaveProperty("topic");
    expect(JSON.stringify(stored!.metadata)).not.toContain("https://youtu.be");
  });

  it("webhook signed delivery applies defaults and fills required derived text before the required check", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    const res = await signedWebhookJson(fixture, { url: "https://youtu.be/dQw4w9WgXcQ" }, "webhook-defaults-1");
    expect(res.status).toBe(202);
    const [delivery] = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "webhook-defaults-1"));
    expect(delivery.runId).toBe(res.body.runId);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, res.body.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({
      section: "manuals",
      url: "https://youtu.be/dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
    }));
    const logs = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.runId), eq(activityLog.action, "workflow_run.created")));
    expect(logs).toHaveLength(1);
    expect(heartbeatWakeup.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("webhook explicit nonblank derived text wins over re-extraction", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    const res = await signedWebhookJson(
      fixture,
      { url: "https://youtu.be/dQw4w9WgXcQ", videoId: "manual-explicit" },
      "webhook-explicit-1",
    );
    expect(res.status).toBe(202);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, res.body.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({ section: "manuals", videoId: "manual-explicit" }));
  });

  it("webhook missing plain required text rejects with structured 400 after normalization and links no run", async () => {
    const fixture = await seedWebhookFixture(db, legacyTextFields);
    const before = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    const res = await signedWebhookJson(fixture, { enabled: false }, "webhook-missing-text-1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow run input values");
    expect(res.body.runId).toBeUndefined();
    expect(res.body.details).toEqual(invalidInputDetails([
      { key: "topic", code: "required", message: expect.any(String) },
    ]));
    const deliveries = await webhookDeliveriesByKey(db, "webhook-missing-text-1");
    for (const delivery of deliveries) expect(delivery.runId).toBeNull();
    const after = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
  });

  it("webhook fresh delivery with invalid radio control rejects with structured 400 and links no run", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    const before = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    // 필수 text·derived 값을 모두 채우고 radio만 무효로 보낸다. 오늘 라우트는 legacy 존재 검사와
    // 파생을 모두 통과해 trigger까지 도달하므로, 이 검사가 RED면 트리거 오류 번역 경계에
    // 타입 검증이 없다는 증거다(리뷰 I1).
    const res = await signedWebhookJson(
      fixture,
      { section: "bogus", url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" },
      "webhook-invalid-control-1",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid workflow run input values");
    expect(res.body.runId).toBeUndefined();
    expect(res.body.details).toEqual(invalidInputDetails([
      { key: "section", code: "invalid_option", message: expect.any(String) },
    ]));
    const deliveries = await webhookDeliveriesByKey(db, "webhook-invalid-control-1");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.runId).toBeNull();
    const after = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
  });

  it("webhook bad signature returns 401 without admission", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    const res = await signedWebhookJson(fixture, {}, "webhook-bad-sig-1", { sig: "00".repeat(32) });
    expect(res.status).toBe(401);
    const deliveries = await webhookDeliveriesByKey(db, "webhook-bad-sig-1");
    expect(deliveries).toHaveLength(0);
    const state = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    expect(state).toEqual({ missions: 0, runs: 0, issues: 0, stepRuns: 0, wakeups: 0 });
  });

  it("webhook quota exhaustion returns 429 without creating runs", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    for (let i = 0; i < 60; i++) {
      await db.insert(workflowWebhookDeliveries).values({
        companyId: fixture.companyId,
        workflowId: fixture.workflowId,
        idempotencyKey: `quota-${fixture.workflowId}-${i}`,
      });
    }
    const res = await signedWebhookJson(fixture, {}, "webhook-quota-over");
    expect(res.status).toBe(429);
    const after = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual({ missions: 0, runs: 0, issues: 0, stepRuns: 0, wakeups: 0 });
  });

  it("webhook replay with invalid new body returns the original run id without new validation or quota debit", async () => {
    const fixture = await seedWebhookFixture(db, webhookFields);
    const first = await signedWebhookJson(
      fixture,
      { section: "manuals", url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" },
      "webhook-replay-1",
    );
    expect(first.status).toBe(202);
    const firstRunId = first.body.runId;
    const replay = await signedWebhookJson(fixture, { section: "bogus" }, "webhook-replay-1");
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ runId: firstRunId, idempotencyKey: "webhook-replay-1" });
    const deliveries = await webhookDeliveriesByKey(db, "webhook-replay-1");
    expect(deliveries).toHaveLength(1);
    const after = await countCompanyRunState(db, fixture.companyId, heartbeatWakeup.mock.calls.length);
    expect(after.runs).toBe(1);
  });

  it("manual POST for another company's workflow is isolated 404 without writes", async () => {
    const owner = await seedRunInputWorkflow(db, manualFields);
    const outsider = await seedRunInputWorkflow(db, []);
    const app = buildBoardApp(db, outsider.companyId);
    const before = await countCompanyRunState(db, owner.companyId, heartbeatWakeup.mock.calls.length);
    const res = await request(app)
      .post(`/api/workflows/${owner.workflowId}/runs`)
      .send({ metadata: { enabled: false } });
    expect(res.status).toBe(404);
    const after = await countCompanyRunState(db, owner.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
  });
});
