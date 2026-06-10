import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlertRules, type SchedulerState } from "../services/alert-rules.js";

describe("alert rules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends scheduler_down only once per continuous down episode", async () => {
    vi.useFakeTimers();
    const state: SchedulerState = { running: false, lastPollAt: null };
    const sendAlert = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const alerts = createAlertRules(() => state, sendAlert);

    alerts.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(sendAlert).toHaveBeenCalledTimes(1);

    state.running = true;
    state.lastPollAt = new Date();
    await vi.advanceTimersByTimeAsync(30_000);

    state.running = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendAlert).toHaveBeenCalledTimes(2);
    alerts.stop();
  });
});
