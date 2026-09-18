/**
 * 판단 계층 공급자(provider) — TypeSafe "System One"/jev 공식 JS SDK 클라이언트 (트랙 B-2).
 *
 * 원칙: "모델은 추론하고, 정책은 허용하며, 검증기는 완료를 확인한다."
 * 이 클라이언트의 결과는 실행 권한이 아니라 권고다.
 *
 * B-2 부터 수제 fetch 클라이언트 대신 공식 `@typesafe-ai/sdk`(v0.6.0)를 쓴다.
 * SDK 가 HTTP 전송·재시도·타임아웃을 소유하고, 우리는 계약(게이트/검증/분류)을 소유한다.
 *
 * - 재시도 단일 소유권: 재시도 정책을 우리가 명시 전달한다(maxRetries 2 + 지수 백오프,
 *   SDK 기본값과 동일한 500ms/5000ms/지터 0.25 — 전부 명시). 총 타임아웃 30s 는 우리가
 *   AbortController 로 예산을 걸고 SDK 에 signal 로 전달한다(SDK 의 per-attempt timeout 은
 *   예산 전액으로 설정 — 단일 시도가 예산을 초과할 수 없고, 재시도 포함 총 예산이 30s 다).
 *   상위 호출자(하트비트 등)는 중첩 재시도를 하지 말고 결과의 attempts 로 이미 재시도되었음을
 *   확인해야 한다. attempts 는 SDK 가 노출하지 않아 주입된 fetch 호출 수로 계산한다.
 * - env 게이트: PAPERCLIP_JUDGMENT_ENABLED (기본 off). off 면 네트워크 호출 없이
 *   disabled 결과. TYPESAFE_API_KEY 가 없으면 네트워크 호출 없이 error.
 * - 모델 버전 고정: model 은 항상 정의의 고정 버전 ID(예: "jev-1.13.0")를 명시 전달한다.
 *   SDK 기본 모델(jev-latest 별칭)은 절대 상속하지 않는다.
 * - 응답 검증: SDK 는 본문을 JSON 파싱만 하므로(검증 없음), answers 구조와 질문 이름 대응은
 *   우리가 검증 후 정형(JudgmentAnswer)으로 반환한다. choice/score 질문의 답 누락, 질문에
 *   없는 answer 키, 값 타입 불일치, score 루브릭 없음은 invalid_response(재시도 없음)다.
 *   noul 질문은 답이 없을 수 있고, 있으면 yes 확률(noul: 0~1)을 value 로 넣는다.
 * - 에러 분류: SDK 에러 클래스(RateLimitError/InternalServerError/APITimeoutError/
 *   APIConnectionError/APIUserAbortError/기타 APIError/TypeSafeError)를 우리 에러 코드로
 *   매핑한다. APIUserAbortError 는 이 공급자가 건 총예산 signal 이 유일한 abort 원인이므로
 *   timeout 으로 분류한다.
 */

import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  APITimeoutError,
  InternalServerError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  type EntryType,
  type Questions,
} from "@typesafe-ai/sdk";
import type {
  JudgmentAnswer,
  JudgmentAskInput,
  JudgmentAskResult,
  JudgmentErrorCode,
  JudgmentQuestion,
} from "@paperclipai/shared";

export interface JudgmentProvider {
  id: string;
  ask(input: JudgmentAskInput): Promise<JudgmentAskResult>;
}

export interface TypesafeProviderDeps {
  /** 주입 가능한 fetch(테스트 목킹용). SDK transport 로 전달된다. */
  fetchFn?: typeof fetch;
  /** TypeSafe API 루트(SDK baseURL). 기본 https://api.typesafe.ai */
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** 재시도 상한(초기 시도 제외). 기본 2. SDK retry.maxRetries 로 명시 전달. */
  maxRetries?: number;
  /** 총 타임아웃 예산(ms, 모든 시도 합산). 기본 30_000. AbortController signal 로 강제. */
  timeoutMs?: number;
  /** 백오프 정책 오버라이드(테스트용 — 실대화면 0ms 로 재시도를 빠르게 돌린다). */
  retryBackoff?: { initialMs?: number; maxMs?: number; jitter?: number };
}

/** TypeSafe API 루트(SDK baseURL). */
export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai";
/** System One 엔드포인트 전체 경로(참조·표시용 — SDK 가 경로를 조립한다). */
export const TYPESAFE_SYSTEMONE_URL = `${TYPESAFE_API_BASE_URL}/v1/systemone`;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
// SDK 기본 백오프와 동일한 값을 "명시적으로" 전달한다(재시도 정책의 단일 소유 확인용).
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_JITTER = 0.25;

function isGateEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PAPERCLIP_JUDGMENT_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ---------------------------------------------------------------------------
// 질문 변환 — JudgmentQuestion[](이름 포함 배열) → SDK Questions(이름 키 맵).
// ---------------------------------------------------------------------------

function toSdkQuestions(questions: JudgmentQuestion[]): Questions {
  const map: Record<string, unknown> = {};
  for (const question of questions) {
    map[question.name] = {
      type: question.type,
      instructions: question.instructions,
      ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
    };
  }
  return map as Questions;
}

// ---------------------------------------------------------------------------
// 응답 검증 — SDK 파싱 결과(원 JSON)를 정형 JudgmentAnswer 로.
// ---------------------------------------------------------------------------

type WireChoiceAnswer = { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };
type WireScoreAnswer = { type?: unknown; score?: unknown; confidence?: unknown; probabilities?: unknown };
type WireNoulAnswer = { type?: unknown; noul?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeChoiceAnswer(question: JudgmentQuestion, raw: unknown): JudgmentAnswer {
  if (!isPlainObject(raw)) throw new Error(`invalid answer for question '${question.name}'`);
  const wire = raw as WireChoiceAnswer;
  if (typeof wire.choice !== "string") {
    throw new Error(`invalid answer for question '${question.name}'`);
  }
  return {
    name: question.name,
    type: "choice",
    value: wire.choice,
    ...(isPlainObject(wire.probabilities)
      ? { probabilities: wire.probabilities as Record<string, number> }
      : {}),
    ...(typeof wire.confidence === "number" ? { confidence: wire.confidence } : {}),
  };
}

function normalizeScoreAnswer(question: JudgmentQuestion, raw: unknown): JudgmentAnswer {
  if (!isPlainObject(raw)) throw new Error(`invalid answer for question '${question.name}'`);
  const wire = raw as WireScoreAnswer;
  if (typeof wire.score !== "number" || !Number.isFinite(wire.score)) {
    throw new Error(`invalid answer for question '${question.name}'`);
  }
  return {
    name: question.name,
    type: "score",
    value: wire.score,
    ...(isPlainObject(wire.probabilities)
      ? { probabilities: wire.probabilities as Record<string, number> }
      : {}),
    ...(typeof wire.confidence === "number" ? { confidence: wire.confidence } : {}),
  };
}

function normalizeNoulAnswer(question: JudgmentQuestion, raw: unknown): JudgmentAnswer {
  if (raw === undefined || raw === null) {
    return { name: question.name, type: "noul", value: null };
  }
  if (!isPlainObject(raw)) throw new Error(`invalid answer for question '${question.name}'`);
  const wire = raw as WireNoulAnswer;
  if (typeof wire.noul !== "number" || !Number.isFinite(wire.noul)) {
    throw new Error(`invalid answer for question '${question.name}'`);
  }
  return { name: question.name, type: "noul", value: wire.noul };
}

function validateSdkResult(
  body: unknown,
  questions: JudgmentQuestion[],
): {
  modelVersion: string;
  answers: JudgmentAnswer[];
  usage: { inputTokens: number; outputTokens: number };
} {
  if (!isPlainObject(body)) {
    throw new Error("response body is not an object");
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new Error("response model is missing");
  }
  if (!isPlainObject(body.answers)) {
    throw new Error("response answers is not an object");
  }
  const usage = body.usage;
  if (
    !isPlainObject(usage) ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    throw new Error("response usage is missing or malformed");
  }

  const answersRecord = body.answers;
  const questionNames = new Set(questions.map((question) => question.name));
  for (const key of Object.keys(answersRecord)) {
    if (!questionNames.has(key)) {
      throw new Error(`answer key '${key}' does not match any question`);
    }
  }

  const answers = questions.map((question) => {
    if (question.type === "noul") {
      return normalizeNoulAnswer(question, answersRecord[question.name]);
    }
    if (!(question.name in answersRecord)) {
      throw new Error(`missing answer for question '${question.name}'`);
    }
    const raw = answersRecord[question.name];
    if (question.type === "choice") return normalizeChoiceAnswer(question, raw);
    return normalizeScoreAnswer(question, raw);
  });

  return {
    modelVersion: body.model,
    answers,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
}

// ---------------------------------------------------------------------------
// 에러 분류 — SDK 에러 클래스 → JudgmentErrorCode.
// ---------------------------------------------------------------------------

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifySdkError(error: unknown): { error: JudgmentErrorCode; message: string } {
  if (error instanceof RateLimitError) {
    return { error: "rate_limited", message: `typesafe rate limited: ${describeUnknown(error)}` };
  }
  if (error instanceof InternalServerError) {
    return { error: "server_error", message: `typesafe server error (HTTP ${error.status})` };
  }
  if (error instanceof APITimeoutError) {
    return {
      error: "timeout",
      message: `typesafe attempt timed out after ${error.timeoutMs}ms`,
    };
  }
  if (error instanceof APIUserAbortError) {
    // 이 공급자가 건 총예산 signal 이 유일한 abort 원인이다(외부 signal 을 받지 않는다).
    return { error: "timeout", message: "judgment request aborted — total timeout budget elapsed" };
  }
  if (error instanceof APIConnectionError) {
    return { error: "network_error", message: describeUnknown(error) };
  }
  if (error instanceof APIError) {
    return {
      error: "http_error",
      message: `typesafe systemone returned HTTP ${error.status}: ${describeUnknown(error)}`,
    };
  }
  // TypeSafeError(질문/설정 검증) 등 클라이언트 계약 위반.
  return { error: "invalid_response", message: describeUnknown(error) };
}

export function createTypesafeProvider(deps: TypesafeProviderDeps = {}): JudgmentProvider {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? TYPESAFE_API_BASE_URL;
  const now = deps.now ?? Date.now;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoff = {
    initialMs: deps.retryBackoff?.initialMs ?? BACKOFF_INITIAL_MS,
    maxMs: deps.retryBackoff?.maxMs ?? BACKOFF_MAX_MS,
    jitter: deps.retryBackoff?.jitter ?? BACKOFF_JITTER,
  };

  return {
    id: "typesafe",
    async ask(input: JudgmentAskInput): Promise<JudgmentAskResult> {
      const env = deps.env ?? process.env;
      const apiKey = deps.apiKey ?? env.TYPESAFE_API_KEY;

      const start = now();

      if (!isGateEnabled(env)) {
        return {
          status: "disabled",
          error: "gate_disabled",
          message: "PAPERCLIP_JUDGMENT_ENABLED is not set; judgment layer is disabled",
          attempts: 0,
          latencyMs: 0,
        };
      }
      if (!apiKey) {
        return {
          status: "error",
          error: "missing_api_key",
          message: "TYPESAFE_API_KEY is not configured",
          attempts: 0,
          latencyMs: 0,
        };
      }

      // attempts 노출: SDK 가 시도 횟수를 알려주지 않으므로 주입 fetch 호출 수로 센다.
      let fetchCalls = 0;
      const countingFetch = ((inputUrl: string, init?: RequestInit) => {
        fetchCalls += 1;
        return fetchFn(inputUrl, init);
      }) as typeof fetch;

      // 총 타임아웃 예산: 우리가 signal 을 소유하고 SDK 에 전달한다.
      // per-attempt timeout 은 예산 전액 — 단일 시도도 예산을 넘을 수 없고,
      // 재시도 대기 중 예산 소진이면 SDK 가 APIUserAbortError 로 나온다.
      const budget = new AbortController();
      const budgetTimer = setTimeout(() => budget.abort(), Math.max(0, timeoutMs));

      try {
        const client = new TypeSafeClient({
          fetch: countingFetch,
          apiKey,
          baseURL: baseUrl,
          // 항상 정의의 고정 modelId 를 명시 전달한다. defaultModel 도 같은 값으로 못박아
          // SDK 기본값(jev-latest 별칭)이 어떤 경로로도 쓰이지 않게 한다.
          defaultModel: input.model,
          retry: {
            maxRetries,
            backoffInitialMs: backoff.initialMs,
            backoffMaxMs: backoff.maxMs,
            backoffJitter: backoff.jitter,
          },
        });

        const result = await client.systemOne(
          {
            // JudgmentAskState 는 jsonb 기반 값이라 JSON 직렬화 가능이 보장된다 —
            // SDK EntryType(JsonValue 위생 타입)으로 좁혀서 전달한다.
            state: input.state as EntryType,
            model: input.model,
            questions: toSdkQuestions(input.questions),
          },
          { timeout: Math.max(1, timeoutMs), signal: budget.signal },
        );

        const validated = validateSdkResult(result, input.questions);
        return {
          status: "ok",
          answers: validated.answers,
          modelVersion: validated.modelVersion,
          usage: validated.usage,
          attempts: fetchCalls,
          latencyMs: now() - start,
        };
      } catch (error) {
        const classified = classifySdkError(error);
        return {
          status: "error",
          error: classified.error,
          message: classified.message,
          attempts: fetchCalls,
          latencyMs: now() - start,
        };
      } finally {
        clearTimeout(budgetTimer);
      }
    },
  };
}
