import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNAWAY_ADVISORY_SOFT_RATIO,
  resolveRunawayAdvisorySoftBytes,
} from "../services/heartbeat-stability.js";

describe("runaway advisory soft threshold", () => {
  it("derives the soft advisory threshold as 60% of the hard limit", () => {
    expect(resolveRunawayAdvisorySoftBytes(20 * 1024 * 1024)).toBe(
      Math.floor(20 * 1024 * 1024 * DEFAULT_RUNAWAY_ADVISORY_SOFT_RATIO),
    );
    expect(resolveRunawayAdvisorySoftBytes(16 * 1024 * 1024)).toBeGreaterThan(9 * 1024 * 1024);
  });

  it("caps the soft threshold at the hard limit so small limits still order correctly", () => {
    expect(resolveRunawayAdvisorySoftBytes(100_000)).toBe(100_000);
    expect(resolveRunawayAdvisorySoftBytes(1024 * 1024)).toBe(1024 * 1024);
    expect(resolveRunawayAdvisorySoftBytes(3 * 1024 * 1024)).toBe(Math.floor(3 * 1024 * 1024 * 0.6));
  });

  it("disables the advisory when the guard itself is disabled", () => {
    expect(resolveRunawayAdvisorySoftBytes(0)).toBe(0);
  });
});
