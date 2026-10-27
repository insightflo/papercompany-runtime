import { describe, expect, it } from "vitest";
import {
  sessionTokenThresholdFieldValue,
  updateSessionTokenThreshold,
} from "./session-compaction-ui";

describe("session compaction UI contract", () => {
  it("shows the adapter default when the override is unset", () => {
    expect(sessionTokenThresholdFieldValue("pi_local", {})).toBe(2_000_000);
    expect(sessionTokenThresholdFieldValue("commandcode_local", {})).toBe(2_000_000);
  });

  it("preserves an explicit zero as token-threshold disabled", () => {
    expect(sessionTokenThresholdFieldValue("pi_local", { maxRawInputTokens: 0 })).toBe(0);
    expect(updateSessionTokenThreshold({ maxSessionMessages: 40 }, 0)).toEqual({
      maxSessionMessages: 40,
      maxRawInputTokens: 0,
    });
  });

  it("rounds positive overrides down without dropping sibling settings", () => {
    expect(updateSessionTokenThreshold({ enabled: true }, 300_000.9)).toEqual({
      enabled: true,
      maxRawInputTokens: 300_000,
    });
  });

  it("normalizes non-finite overrides to an explicit disabled threshold", () => {
    expect(updateSessionTokenThreshold({ maxSessionMessages: 40 }, Number.NaN)).toEqual({
      maxSessionMessages: 40,
      maxRawInputTokens: 0,
    });
  });
});
