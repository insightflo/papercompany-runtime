/**
 * 공급자별 단가 테이블 (USD / 1M 토큰).
 * B-1 은 typesafe 1개만 하드코딩한다. 모르는 공급자는 비용을 추측하지 않고 null.
 */
export const JUDGMENT_PROVIDER_PRICING: Readonly<
  Record<string, { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }>
> = {
  typesafe: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 },
};

export function computeJudgmentCostUsd(
  providerId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!providerId) return null;
  const pricing = JUDGMENT_PROVIDER_PRICING[providerId];
  if (!pricing) return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}
