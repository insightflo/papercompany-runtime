import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettings, judgmentCalls, judgmentDefinitions, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createJudgmentService } from "../services/judgment/judgment-service.js";
import type { JudgmentAskResult, JudgmentQuestion } from "@paperclipai/shared";

type Row = Record<string, unknown>;

const questions: JudgmentQuestion[] = [
  {
    name: "plan_quality",
    type: "choice",
    instructions: "계획 품질을 고르세요",
    criteria: { pass: "통과", fail: "보류" },
  },
  { name: "risk_score", type: "score", instructions: "위험도 0~10", criteria: ["낮음", "높음"] },
  { name: "memo", type: "noul", instructions: "자유 기록(답 없을 수 있음)" },
];

const wireBody = {
  model: "alt-model-1",
  answers: {
    plan_quality: {
      type: "choice",
      choice: "pass",
      probabilities: { pass: 0.8, fail: 0.2 },
      confidence: 0.8,
    },
    risk_score: { type: "score", score: 7, confidence: 0.6 },
    memo: { type: "noul", noul: 0.9 },
  },
  usage: { input_tokens: 1000, output_tokens: 200 },
};

type FetchCall = { url: string; init: RequestInit };

/**
 * 최소 인메모리 DB 픽스처 — 판단 서비스가 사용하는 select/insert/update 체인만
 * 흉내낸다(단일 정의/단일 설정행 픽스처로 조건·정렬을 제어한다).
 */
function makeJudgmentDb() {
  const companyId = "company-jc-1";
  const definitionRow: Row = {
    id: "definition-jc-1",
    companyId,
    name: "plan-qa-prescreen",
    version: 1,
    isActive: true,
    providerId: "typesafe",
    modelId: "jev-1.13.0",
    definition: {
      description: "PLAN-QA 사전 스크리닝",
      stateAssembly: { kind: "inline-ref", notes: "mission plan 본문을 state로 전달" },
      questions,
      policy: { notes: "임계값 미달이면 관측만", thresholds: { minConfidence: 0.6 } },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tableRows = new Map<unknown, Row[]>([
    [instanceSettings, []],
    [judgmentDefinitions, [definitionRow]],
    [judgmentCalls, []],
  ]);
  let nextId = 0;
  const toJson = (value: unknown) => JSON.parse(JSON.stringify(value));
  const rowsQuery = (result: Row[]) => {
    const query: Record<string, unknown> = {
      then: (onFulfilled: (rows: Row[]) => unknown, onRejected?: unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected as never),
    };
    for (const link of ["where", "orderBy", "limit"]) query[link] = () => query;
    return query as never;
  };
  const serializeObjects = (values: Row): Row => {
    const serialized: Row = { ...values };
    for (const key of Object.keys(serialized)) {
      const value = serialized[key];
      if (value !== null && typeof value === "object") serialized[key] = toJson(value);
    }
    return serialized;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => rowsQuery([...(tableRows.get(table) ?? [])]),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const tail = {
          onConflictDoUpdate: () => tail,
          returning: () => {
            const row = { id: `row-${++nextId}`, ...serializeObjects(values) };
            tableRows.get(table)!.push(row);
            return rowsQuery([row]);
          },
        };
        return tail;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: () => {
            const merged = (tableRows.get(table) ?? []).map((row) => ({
              ...row,
              ...serializeObjects(values),
            }));
            tableRows.set(table, merged);
            return rowsQuery(merged);
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, companyId, judgmentCallsTable: tableRows.get(judgmentCalls)! };
}

function makeFetchMock() {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? ({} as RequestInit) });
    return new Response(JSON.stringify(wireBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFn, calls };
}

describe("judgment configurable endpoint/model — whole path", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_JUDGMENT_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("saved settings drive the real provider request URL and model", async () => {
    const { db, companyId } = makeJudgmentDb();
    await instanceSettingsService(db).updateGeneral({
      judgmentBaseUrl: "http://127.0.0.1:9",
      judgmentModelId: "alt-model-1",
    });
    const { fetchFn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fetchFn);

    const service = createJudgmentService(db);
    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-cfg-1",
      state: { plan: "계획 본문" },
    });

    expect(result.status).toBe("observed");
    expect(result.modelVersion).toBe("alt-model-1");
    expect(calls.length).toBe(1);
    expect(new URL(calls[0]!.url).origin).toBe("http://127.0.0.1:9");
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/v1/systemone");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string };
    expect(body.model).toBe("alt-model-1");
    // 기존 판단 API 키(TYPESAFE_API_KEY)가 커스텀 주소로 그대로 전송된다.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("unset overrides keep the default endpoint and the definition model", async () => {
    const { db, companyId } = makeJudgmentDb();
    const { fetchFn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fetchFn);

    const service = createJudgmentService(db);
    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-cfg-2",
      state: { plan: "계획 본문" },
    });

    expect(result.status).toBe("observed");
    expect(result.modelVersion).toBe("alt-model-1");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string };
    expect(body.model).toBe("jev-1.13.0");
  });

  it("injected provider bypasses instance settings (definition model, no network)", async () => {
    const { db, companyId } = makeJudgmentDb();
    await instanceSettingsService(db).updateGeneral({
      judgmentBaseUrl: "http://127.0.0.1:9",
      judgmentModelId: "alt-model-1",
    });
    const { fetchFn, calls } = makeFetchMock();
    vi.stubGlobal("fetch", fetchFn);
    let lastInput: unknown = null;
    const okResult: JudgmentAskResult = {
      status: "ok",
      answers: [
        { name: "plan_quality", type: "choice", value: "pass", confidence: 0.8 },
        { name: "risk_score", type: "score", value: 7, confidence: 0.6 },
        { name: "memo", type: "noul", value: null },
      ],
      modelVersion: "jev-1.13.0",
      usage: { inputTokens: 1000, outputTokens: 200 },
      attempts: 1,
      latencyMs: 5,
    };
    const provider = {
      id: "typesafe",
      async ask(input: unknown) {
        lastInput = input;
        return okResult;
      },
    };

    const service = createJudgmentService(db, { provider });
    const result = await service.askJudgment({
      companyId,
      definitionName: "plan-qa-prescreen",
      contextType: "mission_plan_qa",
      contextId: "mission-cfg-3",
      state: { plan: "계획 본문" },
    });

    expect(result.status).toBe("observed");
    expect((lastInput as { model: string }).model).toBe("jev-1.13.0");
    expect(calls.length).toBe(0);
  });
});
