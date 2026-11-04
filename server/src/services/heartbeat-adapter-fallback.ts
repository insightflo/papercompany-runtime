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
