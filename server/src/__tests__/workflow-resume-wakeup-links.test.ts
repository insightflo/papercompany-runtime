import { describe, expect, it } from "vitest";
import {
  settlementHeartbeatRow,
  wakeupInput,
  wakeupRow,
  type HeartbeatRow,
} from "./helpers/workflow-resume-wakeup-fixture.js";
import {
  checkObservedWakeupConflicts,
  type ObservedWakeupBlocker,
  type ObservedWakeupConflictsInput,
} from "../services/workflow/resume/observed-wakeup-conflicts.js";

/**
 * [purpose] Task5c4a wakeup link semantics and duplicate-identity regressions. Covers the typed
 *   forward (wake.runId) / reverse (heartbeat.wakeupRequestId) bipartite adjacency: missing
 *   references, coalesced-without-pointer, non-reciprocal links, shared terminal heartbeats,
 *   duplicate identities and scope-over-ambiguity precedence. NEGATIVE filter only — empty
 *   blockers never prove eligibility, quiescence or settlement (rules 4-6 of heartbeats belong
 *   to the recorded-settlement checker).
 *   2026-10-22 liveness 교정: wakeup 자체와 실제 edge 로 연결된 heartbeat(양방향)가 모두 종말이면
 *   링크/identity 무결성 위반은 종료 과거 흔적으로 차단하지 않는다. 활성(비종말) 행·활성 상대는
 *   기존 규칙을 그대로 적용한다 — 각 케이스는 활성 변형으로 원 규칙을 보존하고, 종말 잔여는
 *   [] 로 확인한다.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";

const check = (input: ObservedWakeupConflictsInput): ObservedWakeupBlocker[] =>
  checkObservedWakeupConflicts(input);

const hbRow = (overrides: Partial<HeartbeatRow> = {}): HeartbeatRow =>
  settlementHeartbeatRow({ companyId: COMPANY, agentId: "agent-1", ...overrides });

const blockers = (code: ObservedWakeupBlocker["code"], resourceKind: ObservedWakeupBlocker["resourceKind"],
  resourceId: string, reason: ObservedWakeupBlocker["reason"]): ObservedWakeupBlocker =>
  ({ code, resourceKind, resourceId, reason });

describe("checkObservedWakeupConflicts — rule 3 typed links (wakeup side)", () => {
  it("blocks a coalesced wakeup whose runId is null — the pointer to the live run is the link", () => {
    // 2026-10-22 liveness 교정: 역방향 활성(running) heartbeat 가 붙어 행이 live 면 규칙 3 그대로.
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_link_unproven")]);
    // 종말(coalesced) 행 + 종말 상대 없음 의 같은 위반은 과거 흔적 → blocker 없음.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "coalesced" })];
    expect(check(residue)).toEqual([]);
  });

  it("blocks a coalesced wakeup whose runId is absent from the supplied heartbeats", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-gone" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_link_unproven")]);
    // 종말 행 + 공급되지 않은(종말로 간주) 참조의 위반은 과거 흔적 → blocker 없음.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-gone" })];
    expect(check(residue)).toEqual([]);
  });

  it("blocks a non-coalesced wakeup whose nonnull runId is absent — never treated as null", () => {
    // 활성(queued) 행: 규칙 3 이 규칙 4 보다 먼저 발화해 여전히 link_unproven.
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued", runId: "hb-gone" })];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_link_unproven")]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "completed", runId: "hb-gone" })];
    expect(check(residue)).toEqual([]);
  });

  it("accepts a completed wakeup with null runId and no observed reverse heartbeat", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    expect(check(input)).toEqual([]);
  });

  it("blocks a completed null-runId wakeup when a reverse ACTIVE heartbeat is observed", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal")]);
  });

  it("blocks a forward-only ACTIVE heartbeat even for a completed wakeup", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "completed", runId: "hb-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: null })];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal")]);
  });

  it("blocks when the distinct forward heartbeat is terminal but a reverse heartbeat is active", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "completed", runId: "hb-1" })];
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: null }),
      hbRow({ id: "hb-2", status: "running", wakeupRequestId: "wake-1" }),
    ];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal")]);
  });

  it("does not reject non-reciprocity alone: wake→A plus reverse B is checked, not rejected", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "completed", runId: "hb-a" })];
    input.heartbeats = [
      hbRow({ id: "hb-a", status: "succeeded", wakeupRequestId: null }),
      hbRow({ id: "hb-b", status: "succeeded", wakeupRequestId: "wake-1" }),
    ];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — rule 5 breadth over shared/related heartbeats", () => {
  it("accepts many coalesced wakes sharing one terminal heartbeat whose reverse pointer names the original wake", () => {
    const input = wakeupInput();
    input.wakeups = [
      wakeupRow({ id: "wake-a", status: "coalesced", runId: "hb-1" }),
      wakeupRow({ id: "wake-b", status: "coalesced", runId: "hb-1" }),
      wakeupRow({ id: "wake-c", status: "coalesced", runId: "hb-1" }),
    ];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: "wake-a" })];
    expect(check(input)).toEqual([]);
  });

  it("mixed terminal/active related heartbeats block only the wake tied to the active one", () => {
    const input = wakeupInput();
    input.wakeups = [
      wakeupRow({ id: "wake-a", status: "coalesced", runId: "hb-1" }),
      wakeupRow({ id: "wake-b", status: "coalesced", runId: "hb-2" }),
    ];
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: null }),
      hbRow({ id: "hb-2", status: "running", wakeupRequestId: null }),
    ];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-b", "wakeup_linked_heartbeat_not_terminal")]);
  });

  it.each(["failed", "cancelled", "timed_out"])(
    "accepts %s heartbeat records here even when settlement proof is missing (separate checker)",
    (status) => {
      const input = wakeupInput();
      input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
      input.heartbeats = [hbRow({
        id: "hb-1", status,
        terminalOutcome: null, terminalDecidedAt: null, terminalDecisionSource: null,
        settledAt: null, finalizationVersion: 0, executorOwnerReleasedAt: null,
      })];
      expect(check(input)).toEqual([]);
    },
  );

  it("an unlinked heartbeat's status never causes a wakeup blocker", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [hbRow({ id: "hb-9", status: "running", wakeupRequestId: null })];
    expect(check(input)).toEqual([]);
  });

  it("a null heartbeat wakeupRequestId is allowed and an orphan heartbeat needs no wakeup", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: null })];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — broken reverse references (heartbeat-kind diagnostics)", () => {
  it("reports a heartbeat naming a missing wakeup as heartbeat wakeup_link_unproven", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-gone" })];
    expect(check(input)).toEqual([blockers("active_work", "heartbeat", "hb-1", "wakeup_link_unproven")]);
    // 종말(succeeded) heartbeat 의 끊긴 역참조는 과거 흔적 → blocker 없음.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow()];
    residue.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: "wake-gone" })];
    expect(check(residue)).toEqual([]);
  });

  it("duplicate heartbeats with the same missing reverse reference still emit once for the identity", () => {
    const input = wakeupInput();
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-gone" }),
      hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-gone" }),
    ];
    expect(check(input)).toEqual([blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_identity_ambiguous")]);
    const residue = wakeupInput();
    residue.heartbeats = [
      hbRow({ id: "hb-1", wakeupRequestId: "wake-gone" }),
      hbRow({ id: "hb-1", wakeupRequestId: "wake-gone" }),
    ];
    expect(check(residue)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — rule 2 duplicate identities", () => {
  it("detects a duplicated wakeup row once for the identity", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued" }), wakeupRow({ status: "queued" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_identity_ambiguous")]);
    // 종말(completed) 중복 후보만 있으면 과거 흔적 → blocker 없음.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow(), wakeupRow()];
    expect(check(residue)).toEqual([]);
  });

  it("detects a duplicated heartbeat row for the heartbeat identity", () => {
    const input = wakeupInput();
    input.heartbeats = [hbRow({ id: "hb-1", status: "running" }), hbRow({ id: "hb-1", status: "running" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_identity_ambiguous")]);
    const residue = wakeupInput();
    residue.heartbeats = [hbRow({ id: "hb-1" }), hbRow({ id: "hb-1" })];
    expect(check(residue)).toEqual([]);
  });

  it("a duplicated linked heartbeat makes the linking wake ambiguous too", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "running", wakeupRequestId: null }),
      hbRow({ id: "hb-1", status: "running", wakeupRequestId: null }),
    ];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_identity_ambiguous"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_identity_ambiguous"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    residue.heartbeats = [hbRow({ id: "hb-1", wakeupRequestId: null }), hbRow({ id: "hb-1", wakeupRequestId: null })];
    expect(check(residue)).toEqual([]);
  });

  it("a duplicated wake makes the reverse-linking heartbeat ambiguous too", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "queued" }), wakeupRow({ status: "queued" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_identity_ambiguous"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_identity_ambiguous"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow(), wakeupRow()];
    residue.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: "wake-1" })];
    expect(check(residue)).toEqual([]);
  });

  it("an out-of-scope candidate among duplicates wins over ambiguity for both identities and neighbors", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "running" }),
      hbRow({ id: "hb-1", status: "running", companyId: OTHER_COMPANY }),
    ];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    residue.heartbeats = [hbRow({ id: "hb-1" }), hbRow({ id: "hb-1", companyId: OTHER_COMPANY })];
    expect(check(residue)).toEqual([]);
  });

  it("many distinct heartbeats pointing at one wakeup are not an ambiguity", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [
      hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: "wake-1" }),
      hbRow({ id: "hb-2", status: "succeeded", wakeupRequestId: "wake-1" }),
    ];
    expect(check(input)).toEqual([]);
  });

  it("reversed input arrays and reordered duplicate candidates produce deep-equal output", () => {
    const build = (reverse: boolean): ObservedWakeupConflictsInput => {
      const input = wakeupInput();
      const wakes = [wakeupRow(), wakeupRow({ runId: "hb-1" })];
      const beats = [hbRow({ id: "hb-1", wakeupRequestId: "wake-1" }), hbRow({ id: "hb-1", wakeupRequestId: "wake-1" })];
      input.wakeups = reverse ? [...wakes].reverse() : wakes;
      input.heartbeats = reverse ? [...beats].reverse() : beats;
      return input;
    };
    expect(check(build(true))).toEqual(check(build(false)));
  });
});
