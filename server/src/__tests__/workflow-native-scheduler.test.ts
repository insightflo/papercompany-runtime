import { describe, expect, it, vi } from "vitest";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";

describe("native workflow scheduler shadow loop", () => {
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
});
