import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";

describe("native workflow scheduler shadow loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads due candidates on tick without claiming runs in shadow mode", async () => {
    const listCandidates = vi.fn().mockResolvedValue([
      {
        workflowId: "workflow-1",
        companyId: "company-1",
        workflowName: "Daily workflow",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        scheduledAt: new Date("2026-06-11T01:00:00.000Z"),
        runDate: "2026-06-11",
      },
    ]);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "shadow",
      listCandidates,
      logger,
    });

    await scheduler.tick(new Date("2026-06-11T01:05:00.000Z"));

    expect(listCandidates).toHaveBeenCalledWith({} as never, {
      now: new Date("2026-06-11T01:05:00.000Z"),
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      mode: "shadow",
      candidateCount: 1,
      candidates: [
        expect.objectContaining({
          workflowId: "workflow-1",
          scheduledAt: "2026-06-11T01:00:00.000Z",
        }),
      ],
    }), "Native workflow scheduler shadow tick");
  });

  it("does not run overlapping ticks", async () => {
    let resolveFirstTick!: () => void;
    const listCandidates = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirstTick = () => resolve([]);
      }))
      .mockResolvedValue([]);
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "shadow",
      listCandidates,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const firstTick = scheduler.tick(new Date("2026-06-11T01:05:00.000Z"));
    const secondTick = scheduler.tick(new Date("2026-06-11T01:05:10.000Z"));
    resolveFirstTick();
    await Promise.all([firstTick, secondTick]);

    expect(listCandidates).toHaveBeenCalledTimes(1);
  });

  it("claims due candidates on tick in active mode", async () => {
    const candidate = {
      workflowId: "workflow-1",
      companyId: "company-1",
      workflowName: "Daily workflow",
      schedule: "0 10 * * *",
      timezone: "Asia/Seoul",
      scheduledAt: new Date("2026-06-11T01:00:00.000Z"),
      runDate: "2026-06-11",
    };
    const listCandidates = vi.fn().mockResolvedValue([candidate]);
    const claimScheduledRun = vi.fn().mockResolvedValue({
      claimed: true,
      scheduledSlotId: "slot-1",
      run: { runId: "run-1" },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "active",
      listCandidates,
      claimScheduledRun,
      logger,
    });

    await scheduler.tick(new Date("2026-06-11T01:05:00.000Z"));

    expect(claimScheduledRun).toHaveBeenCalledWith({} as never, {
      workflowId: "workflow-1",
      companyId: "company-1",
      scheduledAt: new Date("2026-06-11T01:00:00.000Z"),
      runDate: "2026-06-11",
      timezone: "Asia/Seoul",
      metadata: {
        schedule: "0 10 * * *",
        workflowName: "Daily workflow",
      },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      mode: "active",
      candidateCount: 1,
      claimedCount: 1,
      skippedCount: 0,
      errorCount: 0,
    }), "Native workflow scheduler active tick");
  });

  it("dispatches queued workflow tool steps during active ticks", async () => {
    const listCandidates = vi.fn().mockResolvedValue([]);
    const dispatchQueuedToolSteps = vi.fn().mockResolvedValue({
      claimedCount: 2,
      executedCount: 2,
      failedCount: 0,
      skippedCount: 0,
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const now = new Date("2026-06-11T01:05:00.000Z");
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "active",
      listCandidates,
      dispatchQueuedToolSteps,
      logger,
    });

    await scheduler.tick(now);

    expect(dispatchQueuedToolSteps).toHaveBeenCalledWith({} as never, { now });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      mode: "active",
      candidateCount: 0,
      toolStepClaimedCount: 2,
      toolStepExecutedCount: 2,
      toolStepFailedCount: 0,
    }), "Native workflow scheduler active tick");
  });

  it("dispatches queued tool steps every ten seconds without polling scheduled workflows", async () => {
    const listCandidates = vi.fn().mockResolvedValue([]);
    const dispatchQueuedToolSteps = vi.fn().mockResolvedValue({
      claimedCount: 0,
      executedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "active",
      listCandidates,
      dispatchQueuedToolSteps,
      logger,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    listCandidates.mockClear();
    dispatchQueuedToolSteps.mockClear();
    logger.info.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(dispatchQueuedToolSteps).toHaveBeenCalledTimes(1);
    expect(listCandidates).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "Native workflow tool-step queue tick");
    scheduler.stop();
  });

  it("does not overlap a ten-second queue tick with an unresolved dispatch", async () => {
    let resolveDispatch!: () => void;
    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchQueuedToolSteps = vi.fn().mockImplementation(() => {
      markDispatchStarted();
      return new Promise((resolve) => {
        resolveDispatch = () => resolve({
          claimedCount: 1,
          executedCount: 1,
          failedCount: 0,
          skippedCount: 0,
        });
      });
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "active",
      listCandidates: vi.fn().mockResolvedValue([]),
      dispatchQueuedToolSteps,
      logger,
    });

    scheduler.start();
    await dispatchStarted;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(dispatchQueuedToolSteps).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { mode: "active" },
      "Native workflow tool-step queue tick skipped because previous tick is still running",
    );

    resolveDispatch();
    await Promise.resolve();
    scheduler.stop();
  });

  it("continues active claims after a candidate claim fails", async () => {
    const listCandidates = vi.fn().mockResolvedValue([
      {
        workflowId: "workflow-1",
        companyId: "company-1",
        workflowName: "Broken workflow",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        scheduledAt: new Date("2026-06-11T01:00:00.000Z"),
        runDate: "2026-06-11",
      },
      {
        workflowId: "workflow-2",
        companyId: "company-1",
        workflowName: "Healthy workflow",
        schedule: "0 10 * * *",
        timezone: "Asia/Seoul",
        scheduledAt: new Date("2026-06-11T01:00:00.000Z"),
        runDate: "2026-06-11",
      },
    ]);
    const claimScheduledRun = vi.fn()
      .mockRejectedValueOnce(new Error("owner missing"))
      .mockResolvedValueOnce({ claimed: true, scheduledSlotId: "slot-2", run: { runId: "run-2" } });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scheduler = createNativeWorkflowScheduler({
      db: {} as never,
      mode: "active",
      listCandidates,
      claimScheduledRun,
      logger,
    });

    await scheduler.tick(new Date("2026-06-11T01:05:00.000Z"));

    expect(claimScheduledRun).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "workflow-1",
      err: "owner missing",
    }), "Native workflow scheduler failed to claim due workflow");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      claimedCount: 1,
      errorCount: 1,
    }), "Native workflow scheduler active tick");
  });
});
