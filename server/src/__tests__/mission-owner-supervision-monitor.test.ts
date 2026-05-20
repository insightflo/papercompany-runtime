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

  it("passes owner-action wakeup dependency into mission supervision sweeps", async () => {
    const { createMissionOwnerSupervisionMonitor } = await import("../services/mission-owner-supervision-monitor.js");
    const onOwnerActionCreated = vi.fn();
    const db = {} as never;

    const monitor = createMissionOwnerSupervisionMonitor(db, {
      runImmediately: false,
      onOwnerActionCreated,
    });

    await monitor.run();

    expect(missionServiceMock).toHaveBeenCalledWith(db, {
      onOwnerActionCreated,
    });
    expect(runActiveMissionOwnerSupervision).toHaveBeenCalledWith({
      staleAfterMinutes: 30,
      applySafeActions: true,
    });
  });
});
