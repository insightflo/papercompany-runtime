import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  sweep: vi.fn(),
  recordCadence: vi.fn(),
  revisionSweep: vi.fn(),
  evaluate: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../services/missions.js", () => ({
  missionService: () => ({ runActiveMissionOwnerSupervision: mocks.sweep }),
}));
vi.mock("../services/mission-oversight-shadow.js", () => ({
  recordActiveMissionCadenceShadow: mocks.recordCadence,
  evaluateMissionOversightForMission: mocks.evaluate,
}));
vi.mock("../services/workflow/approved-revision-start.js", () => ({
  sweepApprovedRevisionStarts: mocks.revisionSweep,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";
import { createMissionOversightFailureLane } from "../services/mission-oversight-failure-lane.js";
import { createMissionOversightLivenessLane } from "../services/mission-oversight-liveness-lane.js";

type FakeQuery = Promise<unknown> & {
  from: (...args: unknown[]) => FakeQuery;
  where: (...args: unknown[]) => FakeQuery;
  orderBy: (...args: unknown[]) => FakeQuery;
  limit: (...args: unknown[]) => FakeQuery;
};

function queryFor(result: Promise<unknown>): FakeQuery {
  const query = result as unknown as FakeQuery;
  query.from = () => query;
  query.where = () => query;
  query.orderBy = () => query;
  query.limit = () => query;
  return query;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function emptySweep() {
  return { missionIds: [], missions: [] };
}

describe("mission supervision owner drains", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.sweep.mockResolvedValue(emptySweep());
    mocks.recordCadence.mockResolvedValue(undefined);
    mocks.revisionSweep.mockResolvedValue(undefined);
    mocks.evaluate.mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it("drains both admitted lanes and the full parent sweep, then permits manual runs", async () => {
    const failureEvents = deferred<unknown>();
    const livenessMissions = deferred<unknown>();
    const failureWakeDelivery = deferred<void>();
    const failureWakeStarted = deferred<void>();
    let failureEventsReleased = false;
    const select = vi.fn((projection: Record<string, unknown>) => {
      if ("at" in projection) return queryFor(failureEvents.promise);
      if ("ownerAgentId" in projection) {
        return queryFor(failureEventsReleased
          ? Promise.resolve([{ id: "mission-1", companyId: "company-1", ownerAgentId: "agent-1" }])
          : livenessMissions.promise);
      }
      if (Object.keys(projection).length === 1 && "id" in projection) {
        return queryFor(Promise.resolve([{ id: "oversight-issue-1" }]));
      }
      return queryFor(Promise.resolve([]));
    });
    const insert = vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "failure-wake-claim-1" }]),
        })),
      })),
    }));
    const db = { select, insert } as unknown as Db;
    const parentSweep = deferred<{ missionIds: string[]; missions: [] }>();
    const cadenceShadow = deferred<void>();
    const revisionStarts = deferred<void>();
    mocks.sweep.mockImplementationOnce(() => parentSweep.promise);
    mocks.recordCadence.mockImplementationOnce(() => cadenceShadow.promise);
    mocks.revisionSweep.mockImplementationOnce(() => revisionStarts.promise);
    mocks.evaluate.mockResolvedValue({
      state: "FAILURE_OR_RECOVERY_NEEDED",
      reasonCode: "failure_event_present",
      failureEntities: [{ kind: "step", id: "step-1", status: "failed", version: 1 }],
    });
    const failureWake = vi.fn(async () => {
      failureWakeStarted.resolve();
      await failureWakeDelivery.promise;
    });
    const livenessWake = vi.fn(async () => undefined);
    const monitor = createMissionOwnerSupervisionMonitor(db, {
      intervalMs: 1_000,
      failureLaneIntervalMs: 10,
      livenessLaneIntervalMs: 10,
      runImmediately: false,
      onMissionOversightFailureWakeRequested: failureWake,
      onMissionOversightLivenessGhostWakeRequested: livenessWake,
    });

    monitor.start();
    void monitor.run();
    await flushPromises();
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(select).toHaveBeenCalledTimes(2);
    failureEventsReleased = true;
    failureEvents.resolve([{
      id: "failure-event-1",
      companyId: "company-1",
      missionId: "mission-1",
      at: new Date().toISOString(),
    }]);
    await failureWakeStarted.promise;
    expect(failureWake).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);

    monitor.stop();
    let drained = false;
    const drain = monitor.drain().then(() => { drained = true; });
    const selectCallsAtStop = select.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBe(false);
    expect(select).toHaveBeenCalledTimes(selectCallsAtStop);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);

    livenessMissions.resolve([]);
    await flushPromises();
    expect(drained).toBe(false);
    expect(failureWake).toHaveBeenCalledTimes(1);

    failureWakeDelivery.resolve(undefined);
    await flushPromises();
    expect(drained).toBe(false);

    parentSweep.resolve(emptySweep());
    await flushPromises();
    expect(mocks.recordCadence).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    cadenceShadow.resolve(undefined);
    await flushPromises();
    expect(mocks.revisionSweep).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    revisionStarts.resolve(undefined);
    await drain;
    expect(drained).toBe(true);
    // The durable claim had already admitted this wake before stop; drain waits
    // for its existing handler instead of suppressing its result.
    expect(failureWake).toHaveBeenCalledTimes(1);
    expect(livenessWake).not.toHaveBeenCalled();

    await monitor.run();
    expect(mocks.sweep).toHaveBeenCalledTimes(2);
    expect(mocks.recordCadence).toHaveBeenCalledTimes(2);
    expect(mocks.revisionSweep).toHaveBeenCalledTimes(2);
  });

  it("keeps direct failure and liveness lane runs available after stop", async () => {
    const select = vi.fn(() => queryFor(Promise.resolve([])));
    const db = { select } as unknown as Db;
    const failure = createMissionOversightFailureLane(db, {
      onMissionOversightFailureWakeRequested: vi.fn(async () => undefined),
    });
    const liveness = createMissionOversightLivenessLane(db, {
      onMissionOversightLivenessGhostWakeRequested: vi.fn(async () => undefined),
    });

    failure.start();
    liveness.start();
    failure.stop();
    liveness.stop();
    await failure.run();
    await liveness.run();
    await Promise.all([failure.drain(), liveness.drain()]);

    expect(select).toHaveBeenCalledTimes(2);
  });
});
