import { describe, expect, it } from "vitest";
import {
  settlementHeartbeatRow,
  wakeupInput,
  wakeupRow,
  WAKEUP_OTHER_COMPANY,
  WAKEUP_OTHER_MISSION,
} from "./helpers/workflow-resume-wakeup-fixture.js";
import {
  checkObservedWakeupConflicts,
  type ObservedWakeupBlocker,
  type ObservedWakeupConflictsInput,
} from "../services/workflow/resume/observed-wakeup-conflicts.js";

/**
 * [purpose] Task5c4a observed wakeup conflict filter — pure contract tests for accepted terminal
 *   states and per-identity rule precedence. NEGATIVE filter over supplied records only: empty
 *   blockers prove ONLY that no conflict was found in the supplied rows — never resume
 *   eligibility, never quiescence, never settlement or process absence. Full DB-row typed
 *   factories only (no `as any`); typed link/duplicate-identity regressions live in
 *   workflow-resume-wakeup-links.test.ts; scope edges, adversarial dates, immutability and
 *   deterministic sorting live in workflow-resume-wakeup-boundaries.test.ts.
 *   2026-10-22 liveness 교정: wakeup 자체와 연결된 heartbeat(양방향 edge)가 모두 종말이면
 *   무결성 위반은 종료 과거 흔적으로 차단하지 않고, 활성(비종말) 행·활성 상대는 기존
 *   규칙을 그대로 적용한다(fail-closed 유지).
 */

const T0 = new Date("2024-06-01T00:00:00.000Z");
const T1 = new Date("2024-06-01T01:00:00.000Z");

const check = (input: ObservedWakeupConflictsInput): ObservedWakeupBlocker[] =>
  checkObservedWakeupConflicts(input);

function expectSole(
  blockers: ObservedWakeupBlocker[],
  code: ObservedWakeupBlocker["code"],
  resourceKind: ObservedWakeupBlocker["resourceKind"],
  resourceId: string,
  reason: ObservedWakeupBlocker["reason"],
): void {
  expect(blockers).toEqual([{ code, resourceKind, resourceId, reason }]);
}

describe("checkObservedWakeupConflicts — accepted records (rules 3/4/6 clean)", () => {
  it("returns [] for empty input — explicitly NOT an eligibility/quiescence proof", () => {
    expect(check(wakeupInput())).toEqual([]);
  });

  it.each(["skipped", "completed", "failed", "cancelled"])(
    "accepts terminal wake status %s with no run and valid equal timestamps",
    (status) => {
      expect(check({ ...wakeupInput(), wakeups: [wakeupRow({ status })] })).toEqual([]);
    },
  );

  it("accepts an explicit timed_out wakeup (written by heartbeat.ts though absent from the shared enum)", () => {
    expect(check({ ...wakeupInput(), wakeups: [wakeupRow({ status: "timed_out" })] })).toEqual([]);
  });

  it("accepts a coalesced wakeup whose linked heartbeat is terminal", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [
      settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "succeeded", wakeupRequestId: null }),
    ];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — rule 4 nonterminal/unknown wake state", () => {
  it.each(["queued", "deferred_issue_execution", "claimed", "unknown"])(
    "blocks wake status %s even with a finishedAt present",
    (status) => {
      const row = wakeupRow({ status, finishedAt: T1 });
      expectSole(check({ ...wakeupInput(), wakeups: [row] }), "active_work", "wakeup", "wake-1", "wakeup_not_terminal");
    },
  );
});

describe("checkObservedWakeupConflicts — per-identity rule precedence", () => {
  it("the finished coalesced request does not hide an active heartbeat (plan red test)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [
      settlementHeartbeatRow({
        id: "hb-1", companyId: input.scope.companyId,
        agentId: "agent-1", status: "running", wakeupRequestId: null,
      }),
    ];
    expect(checkObservedWakeupConflicts(input)).toEqual([{
      code: "active_work", resourceKind: "wakeup", resourceId: "wake-1",
      reason: "wakeup_linked_heartbeat_not_terminal",
    }]);
  });

  it("rule 1 scope outranks identity, missing link, state, linked activity and record errors", () => {
    const row = wakeupRow({
      companyId: "company-2",
      status: "queued",
      runId: "hb-gone",
      requestedAt: new Date("not-a-date"),
      finishedAt: null,
    });
    expectSole(check({ ...wakeupInput(), wakeups: [row] }), "scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch");
  });

  it("rule 2 identity ambiguity outranks missing links", () => {
    const input = wakeupInput();
    // 2026-10-22 liveness 교정 이후에도 규칙 우선순위를 계속 검증하도록 활성(queued) 행으로 유지한다.
    input.wakeups = [
      wakeupRow({ status: "queued", runId: "hb-gone", finishedAt: T1 }),
      wakeupRow({ status: "queued", runId: "hb-gone", finishedAt: T1 }),
    ];
    expectSole(check(input), "scope_mismatch", "wakeup", "wake-1", "wakeup_identity_ambiguous");
  });

  it("rule 3 missing link outranks nonterminal state", () => {
    const row = wakeupRow({ runId: "hb-gone", status: "queued", finishedAt: T1 });
    expectSole(check({ ...wakeupInput(), wakeups: [row] }), "active_work", "wakeup", "wake-1", "wakeup_link_unproven");
  });

  it("rule 4 nonterminal state outranks linked heartbeat activity", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued", runId: "hb-1" })];
    input.heartbeats = [settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "running" })];
    expectSole(check(input), "active_work", "wakeup", "wake-1", "wakeup_not_terminal");
  });

  it("rule 5 linked heartbeat activity outranks terminal record errors", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ requestedAt: new Date("not-a-date"), finishedAt: T1, runId: "hb-1" })];
    input.heartbeats = [settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "running" })];
    expectSole(check(input), "active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal");
  });

  it("scope outranks duplicates even when the contaminated linked candidate appears LAST", () => {
    const input = wakeupInput();
    // heartbeat 후보를 활성(running)으로 둬야 양쪽 identity 모두 liveness 게이팅 없이 규칙 1이 적용된다.
    input.wakeups = [wakeupRow({ runId: "hb-1" }), wakeupRow({ runId: "hb-1", companyId: "company-2" })];
    input.heartbeats = [
      settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "running" }),
      settlementHeartbeatRow({ id: "hb-1", companyId: "company-2", status: "running" }),
    ];
    expect(check(input)).toEqual([
      { code: "scope_mismatch", resourceKind: "heartbeat", resourceId: "hb-1", reason: "wakeup_scope_mismatch" },
      { code: "scope_mismatch", resourceKind: "wakeup", resourceId: "wake-1", reason: "wakeup_scope_mismatch" },
    ]);
  });

  it("input order never changes which rule wins — reversed arrays produce deep-equal output", () => {
    const build = (reverse: boolean): ObservedWakeupConflictsInput => {
      const input = wakeupInput();
      const blocked = wakeupRow({ runId: "hb-gone", status: "queued", finishedAt: T1 });
      const healthy = wakeupRow({ id: "wake-2", status: "completed" });
      input.wakeups = reverse ? [healthy, blocked] : [blocked, healthy];
      return input;
    };
    expect(check(build(true))).toEqual(check(build(false)));
    expectSole(check(build(false)), "active_work", "wakeup", "wake-1", "wakeup_link_unproven");
  });

  it("emits at most one blocker per (resourceKind,id) even when several rules would fire", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued", runId: "hb-gone", claimedAt: new Date("nope") })];
    expect(check(input)).toHaveLength(1);
  });
});

describe("checkObservedWakeupConflicts — 2026-10-22 liveness gating (terminal past traces)", () => {
  it("terminal wakeup + terminal linked heartbeat with company/mission mismatch → [] (past trace)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({
      companyId: WAKEUP_OTHER_COMPANY,
      missionId: WAKEUP_OTHER_MISSION,
      runId: "hb-1",
    })];
    input.heartbeats = [settlementHeartbeatRow({
      id: "hb-1", companyId: WAKEUP_OTHER_COMPANY, status: "succeeded", wakeupRequestId: "wake-1",
    })];
    expect(check(input)).toEqual([]);
  });

  it("terminal wakeup + terminal heartbeat with heartbeat-side company mismatch only → []", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ runId: "hb-1" })];
    input.heartbeats = [settlementHeartbeatRow({
      id: "hb-1", companyId: WAKEUP_OTHER_COMPANY, status: "succeeded", wakeupRequestId: "wake-1",
    })];
    expect(check(input)).toEqual([]);
  });

  it("terminal wakeup whose runId points at duplicated terminal heartbeats → [] (ambiguous bookkeeping is a past trace)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ runId: "hb-1" })];
    input.heartbeats = [
      settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "succeeded", wakeupRequestId: null }),
      settlementHeartbeatRow({ id: "hb-1", companyId: input.scope.companyId, status: "succeeded", wakeupRequestId: null }),
    ];
    expect(check(input)).toEqual([]);
  });

  it("terminal wakeup + NONTERMINAL (running) linked heartbeat still blocks — fail-closed kept", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ runId: "hb-1" })];
    input.heartbeats = [settlementHeartbeatRow({
      id: "hb-1", companyId: input.scope.companyId, status: "running", wakeupRequestId: "wake-1",
    })];
    expectSole(check(input), "active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal");
  });

  it("NONTERMINAL (queued) wakeup + terminal linked heartbeat still blocks — fail-closed kept", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued", runId: "hb-1", finishedAt: T1 })];
    input.heartbeats = [settlementHeartbeatRow({
      id: "hb-1", companyId: input.scope.companyId, status: "succeeded", wakeupRequestId: "wake-1",
    })];
    expectSole(check(input), "active_work", "wakeup", "wake-1", "wakeup_not_terminal");
  });
});
