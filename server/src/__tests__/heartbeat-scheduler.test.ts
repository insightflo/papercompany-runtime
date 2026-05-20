import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatScheduler } from "../services/heartbeat-scheduler.js";

describe("heartbeat scheduler loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run recovery on every lightweight scheduler tick", async () => {
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
    };
    const routines = {
      tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
    };

    const scheduler = createHeartbeatScheduler({
      heartbeat,
      routines,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      timerIntervalMs: 30_000,
      routineIntervalMs: 30_000,
      recoveryIntervalMs: 300_000,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(routines.tickScheduledTriggers).toHaveBeenCalledTimes(1);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(270_000);

    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(2);
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("skips overlapping ticks for each scheduler lane", async () => {
    let resolveTimer!: () => void;
    const timerPromise = new Promise<void>((resolve) => {
      resolveTimer = resolve;
    });
    const heartbeat = {
      tickTimers: vi.fn(() => timerPromise.then(() => ({ enqueued: 0 }))),
      reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
    };
    const routines = {
      tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const scheduler = createHeartbeatScheduler({
      heartbeat,
      routines,
      logger,
      timerIntervalMs: 30_000,
      routineIntervalMs: 30_000,
      recoveryIntervalMs: 300_000,
    });

    scheduler.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Skipping heartbeat timer tick because the previous tick is still running");

    resolveTimer();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
