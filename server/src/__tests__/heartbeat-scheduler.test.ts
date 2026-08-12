import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatScheduler } from "../services/heartbeat-scheduler.js";

describe("heartbeat scheduler loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the recovery lane when a recovery tick exceeds the watchdog budget", async () => {
    // Regression: a hung recovery tick must not pin inFlight["recovery"] forever,
    // which previously logged "Skipping heartbeat recovery because the previous
    // tick is still running" for every subsequent tick and starved resumeQueuedRuns.
    let resolveRecovery!: () => void;
    const hungRecovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn(() => hungRecovery.then(() => ({ reaped: 0, runIds: [] }))),
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
    await Promise.resolve();
    await Promise.resolve();
    // First recovery tick is hung.
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);

    // Advance past the watchdog budget (recoveryLaneTimeoutMs = min(4min, interval-30s) = 4min).
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000);
    // Lane released: next recovery tick starts even though the first is still hung.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 4 * 60_000);
    expect(heartbeat.reapOrphanedRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat recovery lane exceeded"),
    );

    // Resolve the hung promise; the watchdog timeout is cleared and no error surfaces.
    resolveRecovery();
    await Promise.resolve();
    await Promise.resolve();
    scheduler.stop();
  });

  it("does not let a late previous recovery finally release a newer flight", async () => {
    // Regression (hardblocker 1): after the watchdog released the lane and a NEW
    // recovery tick started, the OLD hung task's finally must not clear the new
    // tick's inFlight — otherwise the new tick's own finally becomes a no-op and
    // the lane stays stuck forever (or skips the following tick).
    //
    // Generation isolation is observed with stop()/start(): stop() only clears
    // the intervals and leaves inFlight as-is, so a late finally from flight 1
    // would, if it wrongly released the lane, let flight 3 start immediately.
    let resolveFirst!: () => void;
    const firstRecovery = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: () => void;
    const secondRecovery = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn()
        .mockImplementationOnce(() => firstRecovery.then(() => ({ reaped: 0, runIds: [] })))
        .mockImplementationOnce(() => secondRecovery.then(() => ({ reaped: 0, runIds: [] })))
        .mockImplementation(async () => ({ reaped: 0, runIds: [] })),
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
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);

    // Watchdog fires → lane released, generation advanced.
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000);
    // Next recovery tick starts (second hung task). recoveryInterval = 300s,
    // and the previous watchdog already consumed 241s, so 60s more reaches it.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(2);

    // Stop scheduling (intervals cleared; inFlight for the second flight stays true).
    scheduler.stop();

    // The FIRST (old) task finally resolves now. If it wrongly released the
    // current flight, start() would immediately begin a third tick.
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    // Restart: the second flight is still in-flight, so the third tick must be
    // skipped — call count stays 2.
    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(2);

    // Second task completes → its own finally clears the lane, so the next
    // recovery interval can tick.
    resolveSecond();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(heartbeat.reapOrphanedRuns.mock.calls.length).toBeGreaterThanOrEqual(3);

    scheduler.stop();
  });

  it("normal completion releases the recovery lane exactly once for the next tick", async () => {
    // 정상 완료 tick 은 자기 세대 finally 로 inFlight 를 풀고, 다음 tick 이 바로 진행된다.
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
    };
    const routines = { tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const scheduler = createHeartbeatScheduler({
      heartbeat, routines, logger,
      timerIntervalMs: 30_000, routineIntervalMs: 30_000, recoveryIntervalMs: 300_000,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);

    // 첫 tick 이 정상 완료 → 다음 recovery 주기(5분)에 두 번째 tick.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("timeout release and late finally double-release stays idempotent", async () => {
    // timeout 이 inFlight 를 풀고(같은 세대), 이후 늦은 finally 가 같은 세대라 다시 풀어도
    // inFlight=false 는 멱등이라 안전하고, 다음 tick 은 정상 진행된다.
    let resolveHung!: () => void;
    const hung = new Promise<void>((resolve) => { resolveHung = resolve; });
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn()
        .mockImplementationOnce(() => hung.then(() => ({ reaped: 0, runIds: [] })))
        .mockImplementationOnce(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
    };
    const routines = { tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const scheduler = createHeartbeatScheduler({
      heartbeat, routines, logger,
      timerIntervalMs: 30_000, routineIntervalMs: 30_000, recoveryIntervalMs: 300_000,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);

    // timeout 으로 lane release.
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000);
    // 늦은 finally 가 같은 세대라 한 번 더 release (멱등) — 새 tick 이 시작될 수 있다.
    resolveHung();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat.reapOrphanedRuns.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.stop();
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
    await Promise.resolve();
    await Promise.resolve();
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
