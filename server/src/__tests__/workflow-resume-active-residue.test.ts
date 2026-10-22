import { describe, expect, it } from "vitest";
import { activeResidueBlockers } from "../services/workflow/resume/preview-facts.js";

/**
 * [purpose] 2026-10-22 liveness 교정 — wholeMissionBlockers 의 잔여 흔적 판정 계약 테스트.
 *   종료(completed/failed/skipped) 스텝의 toolQueue 예약 기록·소유권 참조와 이슈 체크아웃/실행
 *   참조는 참조된 wakeup/heartbeat 가 실제 활성일 때만 active_work 다(종료 기록은 과거 흔적).
 *   참조가 수집 집합에 없으면 증명 불가로 활성 취급(fail-closed), in_progress 이슈는 종전대로 차단.
 *   빈 결과는 "잔여 없음" 판정만 증명한다 — resume 적격성 전체가 아니다.
 */

interface StepFixture {
  id: string;
  status: string;
  dispatchOwnerWakeupRequestId: string | null;
  dispatchOwnerHeartbeatRunId: string | null;
  metadata: Record<string, unknown>;
}

function step(overrides: Partial<StepFixture> = {}): StepFixture {
  return {
    id: "step-1",
    status: "completed",
    dispatchOwnerWakeupRequestId: null,
    dispatchOwnerHeartbeatRunId: null,
    metadata: {},
    ...overrides,
  };
}

function issue(overrides: Partial<{ id: string; status: string; checkoutRunId: string | null; executionRunId: string | null }> = {}) {
  return { id: "issue-1", status: "todo", checkoutRunId: null, executionRunId: null, ...overrides };
}

describe("activeResidueBlockers — terminal step residue is history, not active work", () => {
  it("completed step with claimed toolQueue reservation is not active work", () => {
    expect(
      activeResidueBlockers([step({ metadata: { toolQueue: { status: "claimed", claimedAt: "t" } } })], [], new Map(), new Map()),
    ).toEqual([]);
  });

  it("failed step with claimed toolQueue reservation is not active work", () => {
    expect(
      activeResidueBlockers([step({ status: "failed", metadata: { toolQueue: { status: "claimed" } } })], [], new Map(), new Map()),
    ).toEqual([]);
  });

  it("skipped step with toolQueue residue is not active work", () => {
    expect(
      activeResidueBlockers([step({ status: "skipped", metadata: { toolQueue: { status: "queued" } } })], [], new Map(), new Map()),
    ).toEqual([]);
  });

  it("pending step with toolQueue reservation stays active (pre-dispatch pipeline)", () => {
    expect(
      activeResidueBlockers([step({ status: "pending", metadata: { toolQueue: { status: "queued" } } })], [], new Map(), new Map()),
    ).toEqual([{ code: "active_work", message: "스텝에 도구 큐 잔존 기록이 있습니다", detail: { stepRunId: "step-1" } }]);
  });

  it("terminal step owner refs pointing at terminal records are history", () => {
    const wakeups = new Map([["wake-1", "completed"]]);
    const heartbeats = new Map([["hb-1", "succeeded"]]);
    expect(
      activeResidueBlockers(
        [step({ dispatchOwnerWakeupRequestId: "wake-1", dispatchOwnerHeartbeatRunId: "hb-1" })],
        [],
        wakeups,
        heartbeats,
      ),
    ).toEqual([]);
  });

  it("terminal step owner ref to a live wakeup (retry in flight) stays active", () => {
    const wakeups = new Map([["wake-1", "claimed"]]);
    expect(
      activeResidueBlockers([step({ dispatchOwnerWakeupRequestId: "wake-1" })], [], wakeups, new Map()),
    ).toHaveLength(1);
  });

  it("terminal step owner ref missing from the collected set stays active (unproven)", () => {
    expect(
      activeResidueBlockers([step({ dispatchOwnerHeartbeatRunId: "hb-missing" })], [], new Map(), new Map()),
    ).toHaveLength(1);
  });

  it("issue with terminal checkout/execution heartbeat refs is history", () => {
    const heartbeats = new Map([["hb-1", "succeeded"], ["hb-2", "failed"]]);
    expect(
      activeResidueBlockers([], [issue({ checkoutRunId: "hb-1", executionRunId: "hb-2" })], new Map(), heartbeats),
    ).toEqual([]);
  });

  it("issue with running execution heartbeat stays active", () => {
    const heartbeats = new Map([["hb-1", "running"]]);
    expect(
      activeResidueBlockers([], [issue({ executionRunId: "hb-1" })], new Map(), heartbeats),
    ).toHaveLength(1);
  });

  it("issue execution ref missing from the collected set stays active (unproven)", () => {
    expect(
      activeResidueBlockers([], [issue({ executionRunId: "hb-missing" })], new Map(), new Map()),
    ).toHaveLength(1);
  });

  it("in_progress issue stays active regardless of refs", () => {
    expect(
      activeResidueBlockers([], [issue({ status: "in_progress" })], new Map(), new Map()),
    ).toHaveLength(1);
  });
});
