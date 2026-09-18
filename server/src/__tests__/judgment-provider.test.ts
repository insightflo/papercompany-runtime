import { describe, expect, it, vi } from "vitest";
import { createTypesafeProvider } from "../services/judgment/provider.js";
import type { JudgmentQuestion } from "@paperclipai/shared";

// B-2: 수제 fetch 클라이언트 → 공식 @typesafe-ai/sdk 전환.
// 목은 SDK 가 주입받은 fetch 수준에서 동작한다(실 Response 객체 반환).
// SDK 기본 백오프(500ms~) 대신 0ms 백오프를 주입해 재시도 테스트를 빠르게 돌린다.

const questions: JudgmentQuestion[] = [
  {
    name: "plan_quality",
    type: "choice",
    instructions: "계획 품질을 고르세요",
    criteria: { pass: "통과", fail: "보류" },
  },
  {
    name: "risk_score",
    type: "score",
    instructions: "위험도 0~10",
    criteria: ["낮음", "높음"],
  },
  { name: "memo", type: "noul", instructions: "자유 기록(답 없을 수 있음)" },
];

// SDK(System One) 응답 본문: answers 는 이름 키 맵, noul 은 yes 확률.
const wireBody = {
  model: "jev-1.13.0",
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

const FAST_BACKOFF = { initialMs: 0, maxMs: 0, jitter: 0 } as const;

function makeFetchMock(responses: Array<Response | Error | ((call: FetchCall) => Response | Error)>) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? ({} as RequestInit) };
    calls.push(call);
    const idx = calls.length - 1;
    const spec = responses[idx];
    const value = typeof spec === "function" ? spec(call) : spec;
    if (value instanceof Error) throw value;
    return value;
  });
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

const enabledEnv = { PAPERCLIP_JUDGMENT_ENABLED: "1", TYPESAFE_API_KEY: "test-key" };

const askInput = { state: { plan: "계획 본문" }, model: "jev-1.13.0", questions };

describe("createTypesafeProvider — 성공 경로", () => {
  it("200 응답을 정형 answers/usage/modelVersion 으로 파싱한다", async () => {
    const { fetchFn, calls } = makeFetchMock([jsonResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.modelVersion).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    expect(result.attempts).toBe(1);
    expect(result.answers).toEqual([
      {
        name: "plan_quality",
        type: "choice",
        value: "pass",
        probabilities: { pass: 0.8, fail: 0.2 },
        confidence: 0.8,
      },
      { name: "risk_score", type: "score", value: 7, confidence: 0.6 },
      { name: "memo", type: "noul", value: 0.9 },
    ]);

    // 요청 계약: POST {base}/v1/systemone, Bearer 인증, {state, model, questions 맵} 본문.
    // model 은 항상 정의의 고정 버전을 명시 전달한다(jev-latest 미사용).
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      state: askInput.state,
      model: "jev-1.13.0",
      questions: {
        plan_quality: { type: "choice", instructions: "계획 품질을 고르세요", criteria: { pass: "통과", fail: "보류" } },
        risk_score: { type: "score", instructions: "위험도 0~10", criteria: ["낮음", "높음"] },
        memo: { type: "noul", instructions: "자유 기록(답 없을 수 있음)" },
      },
    });
  });
});

describe("createTypesafeProvider — 재시도", () => {
  it("429 후 재시도해 성공한다", async () => {
    const { fetchFn, calls } = makeFetchMock([
      jsonResponse(null, 429, { "retry-after": "0" }),
      jsonResponse(wireBody),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.attempts).toBe(2);
    expect(calls.length).toBe(2);
  });

  it("429 가 계속되면 재시도 소진 후 rate_limited error 를 반환한다", async () => {
    const { fetchFn, calls } = makeFetchMock([
      jsonResponse(null, 429, { "retry-after": "0" }),
      jsonResponse(null, 429, { "retry-after": "0" }),
      jsonResponse(null, 429, { "retry-after": "0" }),
      jsonResponse(null, 429, { "retry-after": "0" }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("rate_limited");
    // 기본 최대 2회 재시도 → 총 3회 시도
    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
  });

  it("5xx 는 재시도하고 소진되면 server_error 를 반환한다", async () => {
    const { fetchFn, calls } = makeFetchMock([
      jsonResponse({ error: "bad gateway" }, 502),
      jsonResponse({ error: "unavailable" }, 503),
      jsonResponse({ error: "boom" }, 500),
      jsonResponse({ error: "boom" }, 500),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("server_error");
    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
  });

  it("기타 4xx 는 재시도하지 않고 http_error 를 반환한다", async () => {
    const { fetchFn, calls } = makeFetchMock([jsonResponse({ error: "bad request" }, 400)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("http_error");
    expect(result.attempts).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("createTypesafeProvider — 실패 경로", () => {
  it("총 타임아웃 예산 소진 시 timeout error 를 반환한다", async () => {
    const hangingFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const provider = createTypesafeProvider({
      fetchFn: hangingFetch as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
      timeoutMs: 50,
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("timeout");
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(40);
  }, 10_000);

  it("네트워크 오류는 재시도 후 network_error 를 반환한다", async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = createTypesafeProvider({
      fetchFn: failingFetch as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("network_error");
    expect(result.attempts).toBe(3);
  });

  it("200 이지만 JSON 이 아니면 invalid_response (재시도 없음)", async () => {
    const { fetchFn, calls } = makeFetchMock([textResponse("<html>not json</html>")]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("invalid_response");
    expect(result.attempts).toBe(1);
    expect(calls.length).toBe(1);
  });

  it("질문에 대응하지 않는 answer 키가 있으면 invalid_response", async () => {
    const { fetchFn } = makeFetchMock([
      jsonResponse({
        ...wireBody,
        answers: { ...wireBody.answers, rogue_question: { type: "noul", noul: 1 } },
      }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("invalid_response");
  });

  it("choice/score 질문의 답이 누락되면 invalid_response", async () => {
    const { fetchFn } = makeFetchMock([
      jsonResponse({
        ...wireBody,
        answers: { risk_score: { type: "score", score: 7 } },
      }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("invalid_response");
  });
});

describe("createTypesafeProvider — 게이트/키", () => {
  it("게이트 off(PAPERCLIP_JUDGMENT_ENABLED 없음)면 네트워크 호출 없이 disabled", async () => {
    const { fetchFn, calls } = makeFetchMock([jsonResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: { TYPESAFE_API_KEY: "test-key" },
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("disabled");
    if (result.status !== "disabled") throw new Error("unreachable");
    expect(result.error).toBe("gate_disabled");
    expect(calls.length).toBe(0);
  });

  it("게이트 on 이지만 키가 없으면 네트워크 호출 없이 error(missing_api_key)", async () => {
    const { fetchFn, calls } = makeFetchMock([jsonResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: { PAPERCLIP_JUDGMENT_ENABLED: "1" },
      retryBackoff: { ...FAST_BACKOFF },
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("missing_api_key");
    expect(calls.length).toBe(0);
  });
});
