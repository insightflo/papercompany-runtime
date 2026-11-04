import type { heartbeatRuns } from "@paperclipai/db";
import { asNumber, parseObject } from "../adapters/utils.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";

const DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS = 1;

export type AdapterFallbackConfig = {
  command: string;
  provider?: string;
  model?: string;
  /** [thinking ladder] 폴백 실행에 적용할 추론 수준(단일 값). command/provider/model은 바꾸지 않는다. */
  thinking?: string;
  /** [thinking ladder] 시도 횟수별 추론 수준 사다리(명시 config만 — 자동 승격 금지). */
  thinkingLadder: string[];
  triggers: Set<string>;
  maxAttempts: number;
};

/**
 * [thinking ladder] 폴백 시도(1-based)에 적용할 thinking 값.
 *   - 사다리가 없으면 단일 thinking 값을 매 시도에 적용.
 *   - 사다리가 있으면 ladder[min(attempt-1, len-1)] — 시도가 사다리보다 길면 마지막 값 유지.
 * 어댑터별 정식 순서표가 없어(pi 문서 off~xhigh vs UI minimal~max 불일치) 값 자동 추론/승격은 금지이며,
 * 반드시 agent config(fallback.thinking / fallback.thinkingLadder)에 명시된 값만 사용한다.
 */
export function resolveAdapterFallbackThinking(
  config: Pick<AdapterFallbackConfig, "thinking" | "thinkingLadder">,
  attempt: number,
): string | undefined {
  if (config.thinkingLadder.length === 0) return config.thinking;
  const index = Math.min(Math.max(attempt - 1, 0), config.thinkingLadder.length - 1);
  return config.thinkingLadder[index];
}

export function resolveAdapterFallbackConfig(adapterConfigRaw: unknown): AdapterFallbackConfig | null {
  const adapterConfig = parseObject(adapterConfigRaw);
  const fallback = parseObject(adapterConfig.fallback);
  const command =
    readNonEmptyString(adapterConfig.fallbackCommand) ??
    readNonEmptyString(fallback.command);
  if (!command) return null;
  const provider = readNonEmptyString(fallback.provider) ?? undefined;
  const model = readNonEmptyString(fallback.model) ?? undefined;
  const thinking = readNonEmptyString(fallback.thinking) ?? undefined;
  const rawThinkingLadder = Array.isArray(fallback.thinkingLadder) ? fallback.thinkingLadder : [];
  const thinkingLadder = rawThinkingLadder
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value));

  const rawTriggers = Array.isArray(fallback.triggers) ? fallback.triggers : [];
  const triggers = rawTriggers
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value));
  const maxAttempts = Math.max(
    1,
    Math.floor(asNumber(fallback.maxAttempts ?? adapterConfig.fallbackMaxAttempts, DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS)),
  );

  return {
    command,
    provider,
    model,
    thinking,
    thinkingLadder,
    triggers: triggers.length > 0 ? new Set(triggers) : new Set(["process_lost"]),
    maxAttempts,
  };
}

function shouldApplyAdapterFallbackConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
}) {
  return (
    Boolean(input.run.retryOfRunId) &&
    readNonEmptyString(input.context.wakeReason) === "adapter_fallback" &&
    readNonEmptyString(input.context.fallbackOfRunId) === input.run.retryOfRunId &&
    Boolean(readNonEmptyString(input.context.fallbackCommand))
  );
}

export function applyAdapterFallbackRuntimeConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
  config: Record<string, unknown>;
}) {
  if (!shouldApplyAdapterFallbackConfig(input)) return input.config;
  const command = readNonEmptyString(input.context.fallbackCommand);
  if (!command) return input.config;
  const provider = readNonEmptyString(input.context.fallbackProvider);
  const model = readNonEmptyString(input.context.fallbackModel);
  // [thinking ladder] thinking만 덮어쓴다. command는 enqueue 시점에 현재 command와 동일하게
  //   설정되도록 운용한다(단일 모델 바인딩 유지 — provider/model 불변).
  const thinking = readNonEmptyString(input.context.fallbackThinking);
  return {
    ...input.config,
    command,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}
