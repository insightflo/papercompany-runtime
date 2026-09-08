import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  workflowDefinitions,
  workflowWebhookConfigs,
  workflowWebhookDeliveries,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { WorkflowRunInputValidationError } from "../services/workflow/run-input-normalization.js";
import { workflowRoutes } from "../routes/workflows.js";
import { workflowWebhookRoutes, webhookRawBodyErrorHandler } from "../routes/workflow-webhooks.js";
import { secretService } from "../services/secrets.js";
import { logActivity } from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { freshCompany } from "./helpers/bounded-reads-test-utils.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const mockWorkflowService = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  trigger: vi.fn(),
}));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: mockWorkflowService }));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

// [care] as const: code 필드가 string으로 확장되면 WorkflowRunInputFieldError 리터럴
// 유니언에 배정 불가해 test-graph typecheck(TS2322)가 실패한다.
const SECTION_FIELD_ERROR = { key: "section", code: "invalid_option", message: "선택지를 확인해 주세요." } as const;
const typedSectionError = () =>
  new WorkflowRunInputValidationError([SECTION_FIELD_ERROR]);
const expectedDetails = {
  version: 1,
  code: "invalid_workflow_run_inputs",
  fieldErrors: [SECTION_FIELD_ERROR],
};

describe("manual workflow run route run-input error boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      name: "wf",
      status: "active",
      steps: [],
      runInputs: [
        { key: "url", type: "text", required: true, placeholder: "https://youtu.be/dQw4w9WgXcQ" },
        { key: "videoId", type: "text", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
      ],
    });
  });

  function manualApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", workflowRoutes({} as never));
    app.use(errorHandler);
    return app;
  }

  it("translates a typed engine run-input error into 400 with structured details and no success log", async () => {
    // [care] 파생 선언(videoId←url)이 라우트 프리플라이트로 가로채지 않게 이 케이스만 중립 선언으로
    // 교체한다. 타이핑된 에러는 엔진(모의)에서 나와야 하고 라우트는 이를 400으로 번역만 한다.
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      name: "wf",
      status: "active",
      steps: [],
      runInputs: [
        { key: "section", type: "radio", required: true, options: [{ value: "manuals", label: "매뉴얼" }] },
      ],
    });
    mockWorkflowService.trigger.mockRejectedValue(typedSectionError());

    const res = await request(manualApp())
      .post(`/api/workflows/${WORKFLOW_ID}/runs`)
      .send({ triggeredBy: "board", metadata: { section: "news" } });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expectedDetails);
    expect(mockWorkflowService.trigger).toHaveBeenCalledTimes(1);
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "workflow_run.created" }),
    );
  });

  it("forwards raw metadata to the engine without route-level derivation", async () => {
    mockWorkflowService.trigger.mockResolvedValue({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      missionId: null,
      status: "running",
      completedAt: null,
      stepRuns: [],
    });

    const res = await request(manualApp())
      .post(`/api/workflows/${WORKFLOW_ID}/runs`)
      .send({ triggeredBy: "board", metadata: { url: "https://youtu.be/dQw4w9WgXcQ" } });

    expect(res.status).toBe(201);
    // [care] 전체 호출을 비교하지 않는다(첫 인자에 실제 DB 객체가 있어 실패 시 diff 포맷 OOM 위험).
    // 도메인 값만 경계 projection으로 단언한다.
    expect(mockWorkflowService.trigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockWorkflowService.trigger.mock.calls[0]!;
    expect(triggerCall.length).toBe(2);
    expect(triggerCall[1].metadata).toEqual({ url: "https://youtu.be/dQw4w9WgXcQ" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres webhook run-input error tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("webhook route run-input error boundary (POST /api/webhooks/workflows/:workflowId)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;
  let secretValue!: string;
  let app!: express.Express;

  let lastRunId = "";
  const mockedRunId = () => {
    lastRunId = crypto.randomUUID();
    return lastRunId;
  };

  const signedPost = (body: string, key = `idem-${crypto.randomUUID()}`) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac("sha256", secretValue)
      .update(`${ts}.${body}`)
      .digest("hex");
    return request(app)
      .post(`/api/webhooks/workflows/${workflowId}`)
      .set("Content-Type", "application/json")
      .set("X-Timestamp", ts)
      .set("X-Idempotency-Key", key)
      .set("X-Signature", signature)
      .send(body);
  };

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 13).toString("base64"));
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-input-route-errors-");
    db = createDb(tempDb.connectionString);
    companyId = await freshCompany(db);
    workflowId = crypto.randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "wf" });
    const secrets = secretService(db);
    await secrets.create(companyId, {
      name: `workflow-webhook:${workflowId}`,
      provider: "local_encrypted",
      value: secretValue = "route-errors-secret-v1",
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
    try {
      await db?.$client.end({ timeout: 5 });
    } finally {
      vi.unstubAllEnvs();
      await tempDb?.cleanup();
    }
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: workflowId,
      companyId,
      name: "wf",
      status: "active",
      steps: [],
      runInputs: [
        {
          key: "section",
          type: "radio",
          required: true,
          options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념 설명" }],
        },
        { key: "topic", type: "text", required: true },
      ],
    });
    mockWorkflowService.trigger.mockImplementation(async () => ({
      runId: mockedRunId(),
      workflowId,
      missionId: null,
      status: "running",
      completedAt: null,
      stepRuns: [],
    }));
  });

  it("translates a typed engine run-input error into 400 with structured details and no receipt runId", async () => {
    mockWorkflowService.trigger.mockRejectedValue(typedSectionError());

    const res = await signedPost(JSON.stringify({ section: "news", topic: "release" }), "typed-error-key-1");

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expectedDetails);
    expect(mockWorkflowService.trigger).toHaveBeenCalledTimes(1);
    const [delivery] = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "typed-error-key-1"));
    expect(delivery?.runId ?? null).toBeNull();
    // activity 로깅은 이 파일에서 모의다. 실제 DB 행 수가 아니라 모의 호출로 검증한다.
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("passes raw payload metadata plus the legacy webhook policy to the engine", async () => {
    const res = await signedPost(JSON.stringify({ section: "manuals", topic: "release" }), "policy-key-1");

    expect(res.status).toBe(202);
    // [care] 전체 호출 비교 금지(첫 인자 DB 포함). 3-인자 계약을 경계 projection으로 단언한다.
    expect(mockWorkflowService.trigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockWorkflowService.trigger.mock.calls[0]!;
    expect(triggerCall.length).toBe(3);
    expect(triggerCall[0] === db).toBe(true);
    expect(triggerCall[1]).toMatchObject({
      workflowId,
      companyId,
      triggerSource: "webhook",
      triggeredBy: "webhook",
    });
    expect(triggerCall[1].metadata).toEqual({ section: "manuals", topic: "release" });
    expect(triggerCall[2]).toEqual({ legacyTextRequired: true });
    const [delivery] = await db
      .select()
      .from(workflowWebhookDeliveries)
      .where(eq(workflowWebhookDeliveries.idempotencyKey, "policy-key-1"));
    expect(delivery.runId).toBe(lastRunId);
  });
});