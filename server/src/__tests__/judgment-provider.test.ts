import { describe, expect, it, vi } from "vitest";
import { createTypesafeProvider } from "../services/judgment/provider.js";
import type { JudgmentQuestion } from "@paperclipai/shared";

const questions: JudgmentQuestion[] = [
  { name: "plan_quality", type: "choice", instructions: "계획 품질을 고르세요", criteria: "예산/일정/담당자" },
  { name: "risk_score", type: "score", instructions: "위험도 0~10" },
  { name: "memo", type: "noul", instructions: "자유 기록(답 없을 수 있음)" },
];

const wireBody = {
  model: "jev-1.13.0",
  answers: {
    plan_quality: { value: "pass", probabilities: { pass: 0.8, fail: 0.2 }, confidence: 0.8 },
    risk_score: { value: 7, confidence: 0.6 },
    memo: null,
  },
  usage: { input_tokens: 1000, output_tokens: 200 },
};

type FetchCall = { url: string; init: RequestInit };

function makeFetchMock(responses: Array<unknown | ((call: FetchCall) => unknown)>) {
  const calls: FetchCall[] = [];
  const sleepDelays: number[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? ({} as RequestInit) };
    calls.push(call);
    const idx = calls.length - 1;
    const spec = responses[idx];
    if (typeof spec === "function") return (spec as (c: FetchCall) => unknown)(call);
    return spec;
  });
  const sleep = async (ms: number) => {
    sleepDelays.push(ms);
  };
  return { fetchFn, calls, sleepDelays, sleep };
}

function okResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function textResponse(body: string, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  };
}

const enabledEnv = { PAPERCLIP_JUDGMENT_ENABLED: "1", TYPESAFE_API_KEY: "test-key" };

const askInput = { state: { plan: "계획 본문" }, model: "jev-1.13.0", questions };

describe("createTypesafeProvider — 성공 경로", () => {
  it("200 응답을 정형 answers/usage/modelVersion 으로 파싱한다", async () => {
    const { fetchFn, calls } = makeFetchMock([okResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
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
      { name: "memo", type: "noul", value: null },
    ]);

    // 요청 계약: POST, Bearer 인증, {state, model, questions} 본문
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      state: askInput.state,
      model: "jev-1.13.0",
      questions,
    });
  });
});

describe("createTypesafeProvider — 재시도", () => {
  it("429+Retry-After 를 준수해 1회 재시도 후 성공한다", async () => {
    const { fetchFn, calls, sleepDelays, sleep } = makeFetchMock([
      okResponse(null, 429, { "retry-after": "1" }),
      okResponse(wireBody),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep,
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("ok");
    expect(calls.length).toBe(2);
    expect(sleepDelays.length).toBe(1);
    // Retry-After: 1초 → 최소 1000ms 대기
    expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
  });

  it("429 가 계속되면 재시도 소진 후 rate_limited error 를 반환한다", async () => {
    const { fetchFn, calls } = makeFetchMock([
      okResponse(null, 429, { "retry-after": "0" }),
      okResponse(null, 429, { "retry-after": "0" }),
      okResponse(null, 429, { "retry-after": "0" }),
      okResponse(null, 429, { "retry-after": "0" }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
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
      okResponse(null, 502),
      okResponse(null, 503),
      okResponse(null, 500),
      okResponse(null, 500),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("server_error");
    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
  });

  it("기타 4xx 는 재시도하지 않고 http_error 를 반환한다", async () => {
    const { fetchFn, calls } = makeFetchMock([okResponse({ error: "bad request" }, 400)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
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
      sleep: async () => {},
      timeoutMs: 50,
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("timeout");
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it("네트워크 오류는 재시도 후 network_error 를 반환한다", async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = createTypesafeProvider({
      fetchFn: failingFetch as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
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
      sleep: async () => {},
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
      okResponse({
        ...wireBody,
        answers: { ...wireBody.answers, rogue_question: { value: "x" } },
      }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("invalid_response");
  });

  it("choice/score 질문의 답이 누락되면 invalid_response", async () => {
    const { fetchFn } = makeFetchMock([
      okResponse({ ...wireBody, answers: { risk_score: { value: 7 } } }),
    ]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: enabledEnv,
      sleep: async () => {},
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("invalid_response");
  });
});

describe("createTypesafeProvider — 게이트/키", () => {
  it("게이트 off(PAPERCLIP_JUDGMENT_ENABLED 없음)면 네트워크 호출 없이 disabled", async () => {
    const { fetchFn, calls } = makeFetchMock([okResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: { TYPESAFE_API_KEY: "test-key" },
      sleep: async () => {},
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("disabled");
    if (result.status !== "disabled") throw new Error("unreachable");
    expect(result.error).toBe("gate_disabled");
    expect(calls.length).toBe(0);
  });

  it("게이트 on 이지만 키가 없으면 네트워크 호출 없이 error(missing_api_key)", async () => {
    const { fetchFn, calls } = makeFetchMock([okResponse(wireBody)]);
    const provider = createTypesafeProvider({
      fetchFn: fetchFn as unknown as typeof fetch,
      env: { PAPERCLIP_JUDGMENT_ENABLED: "1" },
      sleep: async () => {},
    });

    const result = await provider.ask(askInput);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toBe("missing_api_key");
    expect(calls.length).toBe(0);
  });
});
