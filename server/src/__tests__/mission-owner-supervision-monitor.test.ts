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

function dbWithMissionIds(...ids: string[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => ids.map((id) => ({ id }))),
        })),
      })),
    })),
  } as never;
}

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
    const db = dbWithMissionIds("mission-1");

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

  it("isolates a failed mission and continues supervising later missions", async () => {
    const { createMissionOwnerSupervisionMonitor } = await import("../services/mission-owner-supervision-monitor.js");
    const { logger } = await import("../middleware/logger.js");
    const conflict = Object.assign(new Error("Owner unblock anchor conflict"), {
      status: 409,
      details: { reason: "owner_unblock_anchor_changed" },
    });
    runActiveMissionOwnerSupervision
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        missionIds: ["healthy-mission"],
        missions: [{
          missionId: "healthy-mission",
          oversightIssueId: null,
          findings: ["mission_closeout_ready"],
          recommendations: [],
          appliedActions: [],
          ownerActionExplanations: [],
          commented: false,
        }],
      });
    const monitor = createMissionOwnerSupervisionMonitor(
      dbWithMissionIds("conflicting-mission", "healthy-mission"),
      { runImmediately: false },
    );

    await monitor.run();

    expect(runActiveMissionOwnerSupervision).toHaveBeenNthCalledWith(1, expect.not.objectContaining({
      missionIds: expect.anything(),
    }));
    expect(runActiveMissionOwnerSupervision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      missionIds: ["conflicting-mission"],
    }));
    expect(runActiveMissionOwnerSupervision).toHaveBeenNthCalledWith(3, expect.objectContaining({
      missionIds: ["healthy-mission"],
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      { err: conflict },
      "Mission owner supervision monitor aggregate sweep failed; retrying by mission",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { err: conflict, missionId: "conflicting-mission" },
      "Mission owner supervision monitor mission sweep failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ missionIds: ["healthy-mission"], findingsCount: 1 }),
      "Mission owner supervision monitor observed active mission issues",
    );
  });

  it("runs sweeps on a 5-minute default interval (not the previous 10 minutes)", async () => {
    const { createMissionOwnerSupervisionMonitor } = await import("../services/mission-owner-supervision-monitor.js");
    const db = dbWithMissionIds("mission-interval");

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
