import { describe, expect, it } from "vitest";
import { normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta } from "../services/heartbeat-usage-totals.js";

describe("heartbeat usage totals", () => {
  it("normalizes usage and reads legacy or raw token fields", () => {
    expect(normalizeUsageTotals({ inputTokens: 10.8, cachedInputTokens: -2, outputTokens: 3 })).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 });
    expect(readRawUsageTotals({ rawInputTokens: 4, inputTokens: 9, outputTokens: 2 })).toEqual({ inputTokens: 4, cachedInputTokens: 0, outputTokens: 2 });
    expect(readRawUsageTotals({})).toBeNull();
  });
  it("uses the new cumulative count after a counter resets", () => {
    expect(deriveNormalizedUsageDelta({ inputTokens: 3, cachedInputTokens: 8, outputTokens: 7 }, { inputTokens: 9, cachedInputTokens: 5, outputTokens: 7 })).toEqual({ inputTokens: 3, cachedInputTokens: 3, outputTokens: 0 });
  });
});
