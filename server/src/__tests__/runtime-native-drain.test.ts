import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const reconciliationMocks = vi.hoisted(() => ({
  reconcileWorkflow: vi.fn(async () => ({
    runnableStepWakeupsQueued: 0,
    deadlockedRunsRecovered: 0,
    stuckRunsRecovered: 0,
    orphanStepsCleaned: 0,
    graceWaitingControlNodesReevaluated: 0,
  })),
  recoverTerminalUnsettledRuns: vi.fn(async () => 0),
  reconcileProvider403LadderWakeups: vi.fn(async () => ({ scheduled: 0 })),
  reconcileQualityIntents: vi.fn(async () => ({ visited: 0 })),
  sweepTerminalMissionOrphanRuns: vi.fn(async () => ({ sweptMissions: 0 })),
  sweepQaRebindCandidates: vi.fn(async () => 0),
  processPendingTerminalEffectIntents: vi.fn(async () => ({ executed: 0, failed: 0 })),
}));

vi.mock("../services/workflow/reconciler.js", () => ({
  reconcileWorkflow: reconciliationMocks.reconcileWorkflow,
}));
vi.mock("../services/heartbeat-finalization/recovery.js", () => ({
  recoverTerminalUnsettledRuns: reconciliationMocks.recoverTerminalUnsettledRuns,
}));
vi.mock("../services/heartbeat-provider403-ladder.js", () => ({
  reconcileProvider403LadderWakeups: reconciliationMocks.reconcileProvider403LadderWakeups,
}));
vi.mock("../services/quality/native-reconcile.js", () => ({
  reconcileQualityIntents: reconciliationMocks.reconcileQualityIntents,
}));
vi.mock("../services/missions/terminal-mission-orphan-sweep.js", () => ({
  sweepTerminalMissionOrphanRuns: reconciliationMocks.sweepTerminalMissionOrphanRuns,
}));
vi.mock("../services/workflow/qa-rebind-candidate.js", () => ({
  sweepQaRebindCandidates: reconciliationMocks.sweepQaRebindCandidates,
}));
vi.mock("../services/workflow/run-terminal-boundary.js", () => ({
  processPendingTerminalEffectIntents: reconciliationMocks.processPendingTerminalEffectIntents,
}));

import { workflowRuns, workflowTransitionEvents } from "@paperclipai/db";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";
import { createNativeWorkflowReconciler } from "../services/workflow/native-reconciler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("native workflow owner drains", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("joins a delayed fit activity probe, prevents rearm, and keeps manual tick available", async () => {
    const delayedSignature = deferred<string>();
    const candidate = {
      workflowId: "workflow-1",
      companyId: "company-1",
      workflowName: "manual workflow",
      schedule: "* * * * *",
      timezone: "UTC",
      scheduledAt: new Date("2026-10-29T00:00:00.000Z"),
      runDate: "2026-10-29",
    };
    const readRunActivitySignature = vi.fn()
      .mockResolvedValueOnce("sig-0")
      .mockResolvedValueOnce("sig-0")
      .mockImplementationOnce(() => delayedSignature.promise)
      .mockResolvedValue("sig-1");
    const listCandidates = vi.fn(async () => [] as Array<typeof candidate>);
    const dispatchQueuedToolSteps = vi.fn(async () => ({
      claimedCount: 0, executedCount: 0, failedCount: 0, skippedCount: 0,
    }));
    const dispatchResumeWork = vi.fn(async () => ({
      claimedCount: 0, acceptedCount: 0, completedCount: 0, blockedCount: 0,
      cancelledCount: 0, failedCount: 0, skippedCount: 0,
    }));
    const refreshFitProfiles = vi.fn(async () => ({ updatedCount: 1, skippedFreshCount: 0 }));
    const claimScheduledRun = vi.fn(async () => ({ claimed: true }));
    const scheduler = createNativeWorkflowScheduler({
      db: {} as unknown as Db,
      mode: "active",
      tickIntervalMs: 60_000,
      toolStepQueueIntervalMs: 60 * 60_000,
      resumeDispatchIntervalMs: 60 * 60_000,
      listCandidates,
      claimScheduledRun,
      dispatchQueuedToolSteps,
      dispatchResumeWork,
      readRunActivitySignature,
      refreshFitProfiles,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readRunActivitySignature).toHaveBeenCalledTimes(2);
    expect(scheduler.getState().fitProfileArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readRunActivitySignature).toHaveBeenCalledTimes(3);

    scheduler.stop();
    let drained = false;
    const drain = scheduler.drain().then(() => { drained = true; });
    await flushPromises();
    expect(drained).toBe(false);
    const automaticCallsAtStop = listCandidates.mock.calls.length;
    const queueCallsAtStop = dispatchQueuedToolSteps.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(listCandidates).toHaveBeenCalledTimes(automaticCallsAtStop);
    expect(dispatchQueuedToolSteps).toHaveBeenCalledTimes(queueCallsAtStop);

    delayedSignature.resolve("sig-1");
    await drain;
    expect(drained).toBe(true);
    expect(scheduler.getState().fitProfileArmed).toBe(false);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(1);

    listCandidates.mockResolvedValueOnce([candidate]);
    await scheduler.tick(new Date("2026-10-29T00:01:00.000Z"));
    expect(claimScheduledRun).toHaveBeenCalledTimes(1);
    expect(dispatchQueuedToolSteps).toHaveBeenCalledTimes(queueCallsAtStop + 1);
    expect(scheduler.getState().fitProfileArmed).toBe(false);
  });

  it("joins a pending reconciliation query, fences timer callbacks, and preserves manual reconcile", async () => {
    const heldQuery = deferred<Array<{ runId: string }>>();
    const orderBy = vi.fn().mockImplementationOnce(() => heldQuery.promise).mockResolvedValue([]);
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy,
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const db = { selectDistinct: vi.fn(() => query) } as unknown as Db;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reconciler = createNativeWorkflowReconciler({ db, intervalMs: 1_000, logger });

    reconciler.start();
    await flushPromises();
    expect(orderBy).toHaveBeenCalledTimes(1);
    reconciler.stop();

    let drained = false;
    const drain = reconciler.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(drained).toBe(false);
    expect(db.selectDistinct).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();

    heldQuery.resolve([]);
    await drain;
    expect(drained).toBe(true);
    expect(reconciliationMocks.reconcileWorkflow).toHaveBeenCalledTimes(1);
    expect(reconciler.getState().running).toBe(false);

    await reconciler.reconcile(new Date("2026-10-29T00:02:00.000Z"));
    expect(db.selectDistinct).toHaveBeenCalledTimes(2);
    expect(reconciliationMocks.reconcileWorkflow).toHaveBeenCalledTimes(2);
    expect(reconciler.getState().tickCount).toBe(2);
  });
});
