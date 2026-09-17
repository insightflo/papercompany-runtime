/**
 * 판단 계층 공급자(provider) — TypeSafe "System One"/jev 클라이언트 (트랙 B-1).
 *
 * 원칙: "모델은 추천하고, 정책은 허용하며, 검증기는 완료를 확인한다."
 * 이 클라이언트의 결과는 실행 권한이 아니라 권고다.
 *
 * - 재시도 단일 소유권: 이 클라이언트가 재시도를 소유한다(기본 최대 2회 재시도,
 *   지수 백오프+지터, Retry-After 헤더 준수, 총 타임아웃 기본 30s).
 *   상위 호출자(하트비트 등)는 중첩 재시도를 하지 말고 결과의 attempts 로
 *   이미 재시도되었음을 확인해야 한다.
 * - env 게이트: PAPERCLIP_JUDGMENT_ENABLED (기본 off). off 면 네트워크 호출 없이
 *   disabled 결과. TYPESAFE_API_KEY 가 없으면 네트워크 호출 없이 error.
 * - 모델 버전 고정: model 은 항상 고정 버전 ID(예: "jev-1.13.0")로 받으며,
 *   응답의 model(modelVersion)을 감사행에 남겨 실제 사용 버전을 재구성 가능하게 한다.
 * - 응답 검증: answers 구조와 질문 이름 대응을 검증 후 정형(JudgmentAnswer)으로
 *   반환한다. choice/score 질문의 답 누락, 질문에 없는 answer 키, 값 타입 불일치는
 *   invalid_response(재시도 없음)다. noul 질문은 답이 없거나 null 일 수 있다.
 */

import type {
  JudgmentAnswer,
  JudgmentAskInput,
  JudgmentAskResult,
  JudgmentQuestion,
} from "@paperclipai/shared";

export interface JudgmentProvider {
  id: string;
  ask(input: JudgmentAskInput): Promise<JudgmentAskResult>;
}

export interface TypesafeProviderDeps {
  /** 주입 가능한 fetch(테스트 목킹용). */
  fetchFn?: typeof fetch;
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 재시도 상한(초기 시도 제외). 기본 2. */
  maxRetries?: number;
  /** 총 타임아웃 예산(ms, 모든 시도 합산). 기본 30_000. */
  timeoutMs?: number;
  /** 백오프 지터 난수원(테스트 주입용). */
  random?: () => number;
}

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER_MS = 250;

function isGateEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PAPERCLIP_JUDGMENT_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "DOMException")
  );
}

function parseRetryAfterMs(headerValue: string | null, now: number): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && trimmed !== "") return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

type WireAnswer = { value?: unknown; probabilities?: unknown; confidence?: unknown };

function normalizeAnswer(question: JudgmentQuestion, raw: unknown): JudgmentAnswer {
  let value: unknown;
  let probabilities: unknown;
  let confidence: unknown;

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const wire = raw as WireAnswer;
    value = wire.value;
    probabilities = wire.probabilities;
    confidence = wire.confidence;
  } else {
    value = raw;
  }

  if (question.type === "noul") {
    return {
      name: question.name,
      type: "noul",
      value: value === undefined || value === null ? null : (value as string | number),
      ...(typeof probabilities === "object" && probabilities !== null
        ? { probabilities: probabilities as Record<string, number> }
        : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
    };
  }

  if (question.type === "choice") {
    if (typeof value !== "string") {
      throw new Error(`invalid answer for question '${question.name}'`);
    }
    return {
      name: question.name,
      type: "choice",
      value,
      ...(typeof probabilities === "object" && probabilities !== null
        ? { probabilities: probabilities as Record<string, number> }
        : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
    };
  }

  // score
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid answer for question '${question.name}'`);
  }
  return {
    name: question.name,
    type: "score",
    value,
    ...(typeof confidence === "number" ? { confidence } : {}),
  };
}

function validateResponseBody(body: unknown, questions: JudgmentQuestion[]): {
  modelVersion: string;
  answers: JudgmentAnswer[];
  usage: { inputTokens: number; outputTokens: number };
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("response body is not an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.trim() === "") {
    throw new Error("response model is missing");
  }
  if (record.answers === null || typeof record.answers !== "object" || Array.isArray(record.answers)) {
    throw new Error("response answers is not an object");
  }
  const usage = record.usage as Record<string, unknown> | undefined;
  if (
    usage === null ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    throw new Error("response usage is missing or malformed");
  }

  const answersRecord = record.answers as Record<string, unknown>;
  const questionNames = new Set(questions.map((question) => question.name));
  for (const key of Object.keys(answersRecord)) {
    if (!questionNames.has(key)) {
      throw new Error(`answer key '${key}' does not match any question`);
    }
  }

  const answers = questions.map((question) => {
    if (question.type === "noul") {
      if (!(question.name in answersRecord)) {
        return { name: question.name, type: "noul" as const, value: null };
      }
      return normalizeAnswer(question, answersRecord[question.name]);
    }
    if (!(question.name in answersRecord)) {
      throw new Error(`missing answer for question '${question.name}'`);
    }
    return normalizeAnswer(question, answersRecord[question.name]);
  });

  return {
    modelVersion: record.model,
    answers,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
}

export function createTypesafeProvider(deps: TypesafeProviderDeps = {}): JudgmentProvider {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? TYPESAFE_SYSTEMONE_URL;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const random = deps.random ?? Math.random;

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

      const deadline = start + timeoutMs;

      const backoffMs = (attempt: number): number =>
        BACKOFF_BASE_MS * 2 ** (attempt - 1) + random() * BACKOFF_JITTER_MS;

      for (let attempt = 1; ; attempt += 1) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          return {
            status: "error",
            error: "timeout",
            message: `judgment request timed out after ${timeoutMs}ms total budget`,
            attempts: attempt - 1,
            latencyMs: now() - start,
          };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        let response: Response;
        try {
          response = (await fetchFn(baseUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              state: input.state,
              model: input.model,
              questions: input.questions.map((question) => ({
                name: question.name,
                type: question.type,
                instructions: question.instructions,
                ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
              })),
            }),
            signal: controller.signal,
          } as RequestInit)) as Response;
        } catch (error) {
          clearTimeout(timer);
          const noBudget = deadline - now() <= 0;
          const last = attempt > maxRetries;
          if (isAbortError(error) || noBudget) {
            return {
              status: "error",
              error: "timeout",
              message: `judgment request aborted before response (attempt ${attempt})`,
              attempts: attempt,
              latencyMs: now() - start,
            };
          }
          if (last) {
            return {
              status: "error",
              error: "network_error",
              message: error instanceof Error ? error.message : "network error",
              attempts: attempt,
              latencyMs: now() - start,
            };
          }
          await sleep(backoffMs(attempt));
          continue;
        }
        clearTimeout(timer);

        if (response.status === 200) {
          let bodyText: string;
          try {
            bodyText = await response.text();
          } catch (error) {
            return {
              status: "error",
              error: "network_error",
              message: error instanceof Error ? error.message : "failed to read response body",
              attempts: attempt,
              latencyMs: now() - start,
            };
          }
          let body: unknown;
          try {
            body = JSON.parse(bodyText);
          } catch {
            return {
              status: "error",
              error: "invalid_response",
              message: "response body is not valid JSON",
              attempts: attempt,
              latencyMs: now() - start,
            };
          }
          try {
            const validated = validateResponseBody(body, input.questions);
            return {
              status: "ok",
              answers: validated.answers,
              modelVersion: validated.modelVersion,
              usage: validated.usage,
              attempts: attempt,
              latencyMs: now() - start,
            };
          } catch (error) {
            return {
              status: "error",
              error: "invalid_response",
              message: error instanceof Error ? error.message : "invalid response shape",
              attempts: attempt,
              latencyMs: now() - start,
            };
          }
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          return {
            status: "error",
            error: "http_error",
            message: `typesafe systemone returned HTTP ${response.status}`,
            attempts: attempt,
            latencyMs: now() - start,
          };
        }
        if (attempt > maxRetries) {
          return {
            status: "error",
            error: response.status === 429 ? "rate_limited" : "server_error",
            message: `typesafe systemone returned HTTP ${response.status} after ${attempt} attempts`,
            attempts: attempt,
            latencyMs: now() - start,
          };
        }
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after") ?? null, now());
        const delay = retryAfterMs ?? backoffMs(attempt);
        await sleep(Math.max(0, Math.min(delay, Math.max(0, deadline - now()))));
      }
    },
  };
}
