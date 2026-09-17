import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, judgmentCalls, judgmentDefinitions } from "@paperclipai/db";
import type { JudgmentAnswer, JudgmentAskResult } from "@paperclipai/shared";
import {
  computeJudgmentCostUsd,
  createJudgmentService,
} from "../services/judgment/judgment-service.js";
import type { JudgmentProvider } from "../services/judgment/provider.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping judgment service tests: ${support.reason ?? "unsupported"}`);
}

function fakeProvider(result: JudgmentAskResult): JudgmentProvider & { lastInput: unknown } {
  let lastInput: unknown = null;
  return {
    id: "typesafe",
    async ask(input) {
      lastInput = input;
      return result;
    },
    get lastInput() {
      return lastInput;
    },
  };
}

const okResult: JudgmentAskResult = {
  status: "ok",
  answers: [
    {
      name: "plan_quality",
      type: "choice",
      value: "pass",
      probabilities: { pass: 0.8, fail: 0.2 },
      confidence: 0.8,
    },
    { name: "risk_score", type: "score", value: 7, confidence: 0.5 },
    { name: "memo", type: "noul", value: null },
  ],
  modelVersion: "jev-1.13.0",
  usage: { inputTokens: 10_000, outputTokens: 5_000 },
  attempts: 1,
  latencyMs: 420,
};

const definitionJson = {
  description: "PLAN-QA 사전 스크리닝",
  stateAssembly: { kind: "inline-ref", notes: "mission plan 본문을 state로 전달" },
  questions: [
    {
      name: "plan_quality",
      type: "choice",
      instructions: "기본 지침",
      criteria: "예산/일정/담당자",
    },
    { name: "risk_score", type: "score", instructions: "위험도 0~10" },
    { name: "memo", type: "noul", instructions: "자유 기록" },
  ],
  policy: { notes: "임계값 미달이면 관측만", thresholds: { minConfidence: 0.6 } },
};

describe("computeJudgmentCostUsd (단가 테이블)", () => {
  it("typesafe 입력 $0.042/1M, 출력 $0 로 계산한다", () => {
    expect(computeJudgmentCostUsd("typesafe", 10_000, 5_000)).toBeCloseTo(0.00042, 9);
    expect(computeJudgmentCostUsd("typesafe", 1_000_000, 1_000_000)).toBeCloseTo(0.042, 9);
  });

  it("모르는 공급자는 null (추측 비용 금지)", () => {
    expect(computeJudgmentCostUsd("unknown", 10_000, 0)).toBeNull();
  });
});

describeEP("judgment service (embedded DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let activeDefinitionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("judgment-service-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Judgment Co",
      status: "active",
      issuePrefix: "JDC1",
    });
    await db.insert(judgmentDefinitions).values([
      {
        companyId,
        name: "plan-qa-prescreen",
        version: 2,
        isActive: false,
        providerId: "typesafe",
        modelId: "jev-1.12.0",
        definition: {
          ...definitionJson,
          description: "구버전 정의",
        },
      },
      {
        companyId,
        name: "plan-qa-prescreen",
        version: 3,
        isActive: true,
        providerId: "typesafe",
        modelId: "jev-1.13.0",
        definition: definitionJson,
      },
    ]);
    const [active] = await db
      .select()
      .from(judgmentDefinitions)
      .where(eq(judgmentDefinitions.version, 3));
    activeDefinitionId = active.id;
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function countCalls(): Promise<number> {
    const rows = await db.select().from(judgmentCalls);
    return rows.length;
  }

  it("성공 시 최신 활성 정의로 호출하고 observed 감사행을 남긴다", async () => {
    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });

    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-42",
      state: { plan: "계획 본문" },
    });

    expect(result.status).toBe("observed");
    expect(result.auditId).toBeTruthy();
    expect(result.answers).toEqual(okResult.answers);
    expect(result.confidence).toBe(0.5); // 정의된 confidence 의 최솟값
    expect(result.modelVersion).toBe("jev-1.13.0");

    // provider 는 활성 정의(v3)의 고정 모델 버전과 정의 질문을 받았다
    expect(provider.lastInput).toMatchObject({
      state: { plan: "계획 본문" },
      model: "jev-1.13.0",
    });

    const [row] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, result.auditId!));
    expect(row).toBeTruthy();
    expect(row.outcome).toBe("observed");
    expect(row.definitionId).toBe(activeDefinitionId);
    expect(row.definitionVersion).toBe(3); // 버전 스냅샷
    expect(row.companyId).toBe(companyId);
    expect(row.contextType).toBe("mission_plan_qa");
    expect(row.contextId).toBe("mission-42");
    expect(row.correlationKey).toBe("mission_plan_qa:mission-42");
    expect(row.inputState).toEqual({ plan: "계획 본문" });
    expect(row.questions).toEqual(definitionJson.questions);
    expect(row.answers).toEqual(okResult.answers);
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.latencyMs).toBe(420);
    expect(row.inputTokens).toBe(10_000);
    expect(row.outputTokens).toBe(5_000);
    // 10_000 입력 토큰 × $0.042/1M + 5_000 출력 × $0 = $0.00042
    expect(Number(row.costUsd)).toBeCloseTo(0.00042, 9);
    expect(row.providerId).toBe("typesafe");
    expect(row.modelVersion).toBe("jev-1.13.0");
  });

  it("questionOverrides 로 질문 지침을 덮어쓰고 실제 보낸 질문을 기록한다", async () => {
    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });

    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-43",
      state: { plan: "다른 계획" },
      questionOverrides: {
        plan_quality: { instructions: "긴급 계획용 지침", criteria: "리스크 우선" },
      },
    });

    expect(result.status).toBe("observed");
    const sent = (provider.lastInput as { questions: JudgmentAnswer[] }).questions as typeof definitionJson.questions;
    expect(sent[0].instructions).toBe("긴급 계획용 지침");
    expect(sent[0].criteria).toBe("리스크 우선");
    expect(sent[1].instructions).toBe("위험도 0~10"); // 덮어쓰지 않은 질문은 원본 유지

    const [row] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, result.auditId!));
    expect(row.questions).toEqual(sent);
  });

  it("provider 실패 시 error 감사행을 남기고 error 상태를 반환한다", async () => {
    const provider = fakeProvider({
      status: "error",
      error: "rate_limited",
      message: "typesafe systemone returned HTTP 429 after 3 attempts",
      attempts: 3,
      latencyMs: 900,
    });
    const service = createJudgmentService(db, { provider });

    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-44",
      state: "텍스트 state",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("rate_limited");
    expect(result.auditId).toBeTruthy();

    const [row] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, result.auditId!));
    expect(row.outcome).toBe("error");
    expect(row.error).toContain("rate_limited");
    expect(row.answers).toBeNull();
    expect(row.attempts).toBe(3);
    expect(row.costUsd).toBeNull();
  });

  it("게이트 비활성(disabled) 결과도 감사행으로 남긴다", async () => {
    const provider = fakeProvider({
      status: "disabled",
      error: "gate_disabled",
      message: "PAPERCLIP_JUDGMENT_ENABLED is not set",
      attempts: 0,
      latencyMs: 0,
    });
    const service = createJudgmentService(db, { provider });

    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-45",
      state: "텍스트 state",
    });

    expect(result.status).toBe("disabled");
    expect(result.auditId).toBeTruthy();

    const [row] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, result.auditId!));
    expect(row.outcome).toBe("disabled");
    expect(row.error).toContain("gate_disabled");
  });

  it("활성 정의가 없으면 감사행 없이 error 를 반환한다 (definitionId NOT NULL 제약)", async () => {
    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });
    const before = await countCalls();

    const result = await service.askJudgment({
      companyId,
      definitionName: "no-such-definition",
      contextType: "mission_plan_qa",
      contextId: "mission-46",
      state: "x",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("no_active_definition");
    expect(result.auditId).toBeNull();
    expect(await countCalls()).toBe(before);
  });

  it("회사 스코프: 다른 회사의 정의 이름은 조회되지 않는다", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Judgment Co",
      status: "active",
      issuePrefix: "JDC2",
    });
    await db.insert(judgmentDefinitions).values({
      companyId: otherCompanyId,
      name: "plan-qa-prescreen",
      version: 1,
      isActive: true,
      providerId: "typesafe",
      modelId: "jev-1.13.0",
      definition: definitionJson,
    });

    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });

    // 원래 회사는 여전히 자기 정의(v3)를 쓴다
    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-47",
      state: "x",
    });
    const [row] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, result.auditId!));
    expect(row.definitionVersion).toBe(3);
  });
});
