import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const runActiveMissionOwnerSupervision = vi.fn(async () => ({
  missionIds: [],
  missions: [],
}));
const missionServiceMock = vi.fn(() => ({
  runActiveMissionOwnerSupervision,
}));

vi.mock("../services/missions.js", () => ({
  missionService: missionServiceMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe("createMissionOwnerSupervisionMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    missionServiceMock.mockClear();
    runActiveMissionOwnerSupervision.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes owner-action and source wakeup dependencies into active supervision sweeps", async () => {
    const { createMissionOwnerSupervisionMonitor } = await import("../services/mission-owner-supervision-monitor.js");
    const onOwnerActionCreated = vi.fn();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    const onStaleSourceIssueWakeupRequested = vi.fn();
    const db = {} as never;

    const monitor = createMissionOwnerSupervisionMonitor(db, {
      runImmediately: false,
      onOwnerActionCreated,
      onOwnerDecisionRetrySourceIssueApplied,
      onStaleSourceIssueWakeupRequested,
    });

    await monitor.run();

    expect(missionServiceMock).toHaveBeenCalledWith(db, {
      onOwnerActionCreated,
      onOwnerDecisionRetrySourceIssueApplied,
      onStaleSourceIssueWakeupRequested,
    });
    expect(runActiveMissionOwnerSupervision).toHaveBeenCalledWith({
      staleAfterMinutes: 30,
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
      dispatchStaleSourceIssueWakeups: false,
    });
  });

  it("runs sweeps on a 5-minute default interval (not the previous 10 minutes)", async () => {
    const { createMissionOwnerSupervisionMonitor } = await import("../services/mission-owner-supervision-monitor.js");
    const db = {} as never;

    const monitor = createMissionOwnerSupervisionMonitor(db, { runImmediately: false });
    monitor.start();
    try {
      // immediate + run() not called by start() because runImmediately=false; sweep
      // fires only on the interval. Just under 5 minutes -> still one scheduled call.
      expect(runActiveMissionOwnerSupervision).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
      expect(runActiveMissionOwnerSupervision).not.toHaveBeenCalled();
      // Crossing the 5-minute mark fires exactly one sweep.
      await vi.advanceTimersByTimeAsync(1);
      expect(runActiveMissionOwnerSupervision).toHaveBeenCalledTimes(1);
      // The old 10-minute cadence would not have fired yet at 5 minutes.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(runActiveMissionOwnerSupervision).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
    }
  });
});
