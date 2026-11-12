import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted: mock fns must exist before the static imports below evaluate the
// monitor module (vi.mock factories run lazily at import time). Importing at top
// level also loads the module graph once at collection, so tests don't pay a
// lazy dynamic-import cost inside the 10s test timeout under fake timers.
const { runActiveMissionOwnerSupervision, missionServiceMock } = vi.hoisted(() => {
  const runActiveMissionOwnerSupervision = vi.fn(async () => ({
    missionIds: [],
    missions: [],
  }));
  return {
    runActiveMissionOwnerSupervision,
    missionServiceMock: vi.fn(() => ({
      runActiveMissionOwnerSupervision,
    })),
  };
});

vi.mock("../services/missions.js", () => ({
  missionService: missionServiceMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";
import { logger } from "../middleware/logger.js";

function dbWithMissionIds(...ids: string[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Thenable + orderBy in one: awaited where() chains (flag gate, post-sweep
        // helpers) resolve to [], while the missions fallback query uses orderBy.
        where: vi.fn(() => Object.assign(Promise.resolve([] as Array<{ id: string }>), {
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
