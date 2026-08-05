import { describe, expect, it } from "vitest";
import type { HeartbeatRunDailyStat } from "@paperclipai/shared";
import { groupRunsForActivityChart } from "./ActivityCharts";

describe("groupRunsForActivityChart cancelled aggregation", () => {
  const day = "2026-08-05";

  it("includes cancelled runs in the other bucket", () => {
    const stats: HeartbeatRunDailyStat[] = [
      { day, succeeded: 5, failed: 2, cancelled: 3, timedOut: 1, other: 0, total: 11 },
    ];
    const grouped = groupRunsForActivityChart(stats, [day]);
    const entry = grouped.get(day)!;
    expect(entry.succeeded).toBe(5);
    expect(entry.failed).toBe(3); // 2 failed + 1 timedOut
    expect(entry.other).toBe(3); // cancelled folded in
    expect(entry.succeeded + entry.failed + entry.other).toBe(11);
  });

  it("pure-cancelled day is visible (not silently dropped)", () => {
    const stats: HeartbeatRunDailyStat[] = [
      { day, succeeded: 0, failed: 0, cancelled: 4, timedOut: 0, other: 0, total: 4 },
    ];
    const grouped = groupRunsForActivityChart(stats, [day]);
    const entry = grouped.get(day)!;
    expect(entry.other).toBe(4);
    expect(entry.succeeded + entry.failed + entry.other).toBe(4);
  });
});
