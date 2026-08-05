import { describe, expect, it } from "vitest";
import {
  clampAttentionLimit,
  clampRunListLimit,
  clampStatsDays,
} from "../services/heartbeat-bounded-reads.js";

describe("heartbeat bounded-read limit clamps", () => {
  it("defaults missing or invalid limits to 100", () => {
    expect(clampRunListLimit(undefined)).toBe(100);
    expect(clampRunListLimit(null)).toBe(100);
    expect(clampRunListLimit(Number.NaN)).toBe(100);
    expect(clampRunListLimit(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it("caps the list limit at 500 and floors at 1", () => {
    expect(clampRunListLimit(1000)).toBe(500);
    expect(clampRunListLimit(501)).toBe(500);
    expect(clampRunListLimit(0)).toBe(1);
    expect(clampRunListLimit(-5)).toBe(1);
    expect(clampRunListLimit(250.9)).toBe(250);
  });

  it("clamps stats days to 14 default / 90 max / 1 min", () => {
    expect(clampStatsDays(undefined)).toBe(14);
    expect(clampStatsDays(200)).toBe(90);
    expect(clampStatsDays(0)).toBe(1);
    expect(clampStatsDays(7)).toBe(7);
  });

  it("clamps attention limit to 50 default / 200 max / 1 min", () => {
    expect(clampAttentionLimit(undefined)).toBe(50);
    expect(clampAttentionLimit(500)).toBe(200);
    expect(clampAttentionLimit(0)).toBe(1);
    expect(clampAttentionLimit(20)).toBe(20);
  });
});
