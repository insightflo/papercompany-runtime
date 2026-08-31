import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";

/**
 * [activity-driven fit scheduler] 런이 스케줄을 켜고 끈다:
 * 1) 부트: 즉시 1회 평기(부트스트랩) 후 10분 스케줄 가동
 * 2) 한 주기 동안 새 런 활동 없음 → 스케줄 자기중단 (disarm)
 * 3) 새 런 활동 발생 → 메인 틱 프로브가 재가동 (arm) + 즉시 평가
 * 전부 주입형 가짜로 검증 (실 DB 미사용).
 */

const dummyDb = {} as unknown as Db;

function createFakes() {
  const refreshFitProfiles = vi.fn().mockResolvedValue({ updatedCount: 1, skippedFreshCount: 0 });
  const signatures: string[] = [];
  const readRunActivitySignature = vi.fn(async () => signatures[0] ?? "sig-0");
  const scheduler = createNativeWorkflowScheduler({
    db: dummyDb,
    mode: "active",
    tickIntervalMs: 60_000,
    listCandidates: vi.fn().mockResolvedValue([]),
    dispatchQueuedToolSteps: vi.fn().mockResolvedValue({ claimedCount: 0, executedCount: 0, failedCount: 0, skippedCount: 0 }),
    refreshFitProfiles,
    readRunActivitySignature,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  const setSignature = (value: string) => {
    signatures[0] = value;
  };
  return { scheduler, refreshFitProfiles, readRunActivitySignature, setSignature };
}

describe("activity-driven agent fit scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bootstraps once, disarms after a quiet cycle, and re-arms on new run activity", async () => {
    const { scheduler, refreshFitProfiles, setSignature } = createFakes();
    scheduler.start();
    // 부트스트랩: start 즉시 1회 평가 (await pending microtasks)
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(1);
    expect(scheduler.getState().fitProfileArmed).toBe(true);

    // 정주기(10분) — 서명 그대로(새 런 없음) → 자기중단
    setSignature("sig-0");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(1); // 재계산 없음
    expect(scheduler.getState().fitProfileArmed).toBe(false);

    // 조용한 상태로 여러 주기 — 스케줄 실행 없음
    await vi.advanceTimersByTimeAsync(3 * 10 * 60_000);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(1);

    // 새 런 활동 → 메인 틱(60s) 프로브가 재가동 + 즉시 평가
    setSignature("sig-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.getState().fitProfileArmed).toBe(true);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(2);

    // 재가동 후 런이 계속되면 10분 주기 평가 지속
    setSignature("sig-2");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshFitProfiles).toHaveBeenCalledTimes(3);
    expect(scheduler.getState().fitProfileArmed).toBe(true);

    scheduler.stop();
    expect(scheduler.getState().fitProfileArmed).toBe(false);
  });

  it("shadow mode never arms the fit schedule", async () => {
    const refreshFitProfiles = vi.fn().mockResolvedValue({ updatedCount: 0, skippedFreshCount: 0 });
    const scheduler = createNativeWorkflowScheduler({
      db: dummyDb,
      mode: "shadow",
      tickIntervalMs: 60_000,
      listCandidates: vi.fn().mockResolvedValue([]),
      refreshFitProfiles,
      readRunActivitySignature: vi.fn(async () => "sig-0"),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshFitProfiles).not.toHaveBeenCalled();
    expect(scheduler.getState().fitProfileArmed).toBe(false);
    scheduler.stop();
  });
});
