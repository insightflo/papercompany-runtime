import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", () => ({ schedules: {} }));

import type { Db } from "@paperclipai/db";
import { createHeartbeatScheduler } from "../services/heartbeat-scheduler.js";
import { createScheduler } from "../services/scheduler/cron-wakeup.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("runtime producer drains", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the original heartbeat recovery after its timeout and fences old timers", async () => {
    vi.useFakeTimers();
    const recovery = deferred<unknown>();
    const heartbeat = {
      tickTimers: vi.fn(async () => ({ enqueued: 0 })),
      reapOrphanedRuns: vi.fn(() => recovery.promise),
      reapStaleBusyMissionRuntimes: vi.fn(async () => undefined),
      reapStalledIssueExecutionLocks: vi.fn(async () => undefined),
      resumeQueuedRuns: vi.fn(async () => undefined),
    };
    const routines = { tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = createHeartbeatScheduler({
      heartbeat,
      routines,
      logger,
      timerIntervalMs: 1_000,
      routineIntervalMs: 1_000,
      recoveryIntervalMs: 30_001,
    });

    scheduler.start();
    await flushPromises();
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);

    scheduler.stop();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Heartbeat recovery lane exceeded"));
    expect(drained).toBe(false);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(heartbeat.tickTimers).not.toHaveBeenCalled();
    expect(routines.tickScheduledTriggers).not.toHaveBeenCalled();

    recovery.resolve(undefined);
    await drain;
    expect(drained).toBe(true);
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
  });

  it("joins an admitted cron DB poll while preserving manual polling after stop", async () => {
    vi.useFakeTimers();
    const heldPoll = deferred<unknown>();
    const db = {
      execute: vi.fn()
        .mockImplementationOnce(() => heldPoll.promise)
        .mockResolvedValueOnce([{
          id: "schedule-1",
          company_id: "company-1",
          agent_id: "agent-1",
          mission_id: "mission-1",
          cron_expression: "* * * * *",
          timezone: "UTC",
        }]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    } as unknown as Db;
    const enqueueWakeup = vi.fn(async () => undefined);
    const scheduler = createScheduler(db, { heartbeat: { enqueueWakeup } });

    scheduler.start();
    await flushPromises();
    expect(db.execute).toHaveBeenCalledTimes(1);

    scheduler.stop();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await flushPromises();
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.execute).toHaveBeenCalledTimes(1);

    await scheduler.pollCycle();
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup).toHaveBeenCalledWith("agent-1", {
      source: "scheduler",
      triggerDetail: "schedule:schedule-1",
      missionId: "mission-1",
      reason: "scheduled_wakeup",
    });

    heldPoll.resolve([]);
    await drain;
    expect(drained).toBe(true);
    expect(scheduler.getState().running).toBe(false);
  });
});
