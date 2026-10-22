import { describe, expect, it } from "vitest";
import {
  settlementHeartbeatRow,
  wakeupInput,
  wakeupRow,
  WAKEUP_T0_ISO,
  WAKEUP_T1_ISO,
  type HeartbeatRow,
  type WakeRow,
} from "./helpers/workflow-resume-wakeup-fixture.js";
import {
  checkObservedWakeupConflicts,
  type ObservedWakeupBlocker,
  type ObservedWakeupConflictsInput,
} from "../services/workflow/resume/observed-wakeup-conflicts.js";

/**
 * [purpose] Task5c4a boundary regressions: scope edges (company/mission/actual-edge agent
 *   mismatches), adversarial wakeup timestamps (rule 6, including runtime adversarial casts for
 *   null/non-Date values the DB cannot produce), fields this filter must ignore
 *   (payload/reason/error prose, old generations and other workflowRunIds), caller-input
 *   immutability and deterministic codepoint sorting including delimiter-looking ids.
 *   NEGATIVE filter only — no positive eligibility flag is ever derived.
 *   2026-10-22 liveness 교정: 행 자체와 실제 edge 로 연결된 상대가 모두 종말이면 scope/기록
 *   무결성 위반은 종료 과거 흔적으로 차단하지 않고, 활성(비종말) 행·활성 상대는 기존 규칙을
 *   그대로 적용한다(fail-closed 유지). 원 규칙 검증은 활성 변형으로 보존하고 종말 잔여는 []
 *   로 확인한다. 규칙 6(wakeup_terminal_record_unproven)은 게이팅 후 live 행에서 규칙 4·5가
 *   먼저 발화해 단독 도달이 불가하다 — 아래 그림자 케이스가 그 동작을 고정한다.
 */

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const T0 = new Date(WAKEUP_T0_ISO);
const T1 = new Date(WAKEUP_T1_ISO);

const check = (input: ObservedWakeupConflictsInput): ObservedWakeupBlocker[] =>
  checkObservedWakeupConflicts(input);

const hbRow = (overrides: Partial<HeartbeatRow> = {}): HeartbeatRow =>
  settlementHeartbeatRow({ companyId: COMPANY, agentId: "agent-1", ...overrides });

const blockers = (code: ObservedWakeupBlocker["code"], resourceKind: ObservedWakeupBlocker["resourceKind"],
  resourceId: string, reason: ObservedWakeupBlocker["reason"]): ObservedWakeupBlocker =>
  ({ code, resourceKind, resourceId, reason });

describe("checkObservedWakeupConflicts — rule 1 scope edges", () => {
  it("blocks a wakeup whose own company is out of scope", () => {
    // 2026-10-22 liveness 교정: 활성(queued) 행은 기존 규칙 1 그대로 차단.
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ companyId: OTHER_COMPANY, status: "queued" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch")]);
    // 종말(completed) 행의 같은 위반은 과거 흔적 → blocker 없음.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ companyId: OTHER_COMPANY })];
    expect(check(residue)).toEqual([]);
  });

  it("blocks a heartbeat whose own company is out of scope", () => {
    const input = wakeupInput();
    input.heartbeats = [hbRow({ id: "hb-1", companyId: OTHER_COMPANY, status: "running" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch")]);
    const residue = wakeupInput();
    residue.heartbeats = [hbRow({ id: "hb-1", companyId: OTHER_COMPANY })];
    expect(check(residue)).toEqual([]);
  });

  it("blocks a wake mission mismatch while null mission stays legacy-allowed", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ missionId: "mission-2", status: "queued" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch")]);
    // 종말 행의 mission 불일치는 과거 흔적, null mission 은 계속 legacy 허용.
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ missionId: "mission-2" })];
    expect(check(residue)).toEqual([]);
    const nullMission = wakeupInput();
    nullMission.wakeups = [wakeupRow({ missionId: null })];
    expect(check(nullMission)).toEqual([]);
  });

  it("a cross-company linked heartbeat contaminates its wake (direct adjacency only)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: null, companyId: OTHER_COMPANY })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    residue.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: null, companyId: OTHER_COMPANY })];
    expect(check(residue)).toEqual([]);
  });

  it("an agentId mismatch on a FORWARD edge blocks both identities", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ agentId: "agent-1", status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", agentId: "agent-2", wakeupRequestId: null })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ agentId: "agent-1", status: "coalesced", runId: "hb-1" })];
    residue.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", agentId: "agent-2", wakeupRequestId: null })];
    expect(check(residue)).toEqual([]);
  });

  it("an agentId mismatch on a REVERSE edge blocks both identities", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ agentId: "agent-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "running", agentId: "agent-2", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
    const residue = wakeupInput();
    residue.wakeups = [wakeupRow({ agentId: "agent-1" })];
    residue.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", agentId: "agent-2", wakeupRequestId: "wake-1" })];
    expect(check(residue)).toEqual([]);
  });

  it("unrelated agent differences without an actual edge are allowed", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ agentId: "agent-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", agentId: "agent-2", wakeupRequestId: null })];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — rule 6 wakeup record timestamps", () => {
  it("equal requestedAt/finishedAt are valid (default fixture record)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ requestedAt: T0, finishedAt: T0 })];
    expect(check(input)).toEqual([]);
  });

  it("a null requestedAt (runtime adversarial cast) on a terminal row is a past trace → no blocker", () => {
    // 2026-10-22 liveness 교정: 종말(completed) 행의 기록 위반은 과거 흔적.
    const input = wakeupInput();
    const adversarial = { ...wakeupRow(), requestedAt: null } as unknown as WakeRow;
    input.wakeups = [adversarial];
    expect(check(input)).toEqual([]);
  });

  it.each([
    ["invalid requestedAt", { requestedAt: new Date("not-a-date") }],
    ["null finishedAt", { finishedAt: null }],
    ["invalid finishedAt", { finishedAt: new Date("nope") }],
    ["finishedAt earlier than requestedAt", { requestedAt: T1, finishedAt: T0 }],
    ["invalid claimedAt", { claimedAt: new Date("bad") }],
  ] as Array<[string, Partial<WakeRow>]>)("%s on a terminal row is a past trace → no blocker", (_label, overrides) => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow(overrides)];
    expect(check(input)).toEqual([]);
  });

  it("a non-Date claimedAt string (adversarial cast) on a terminal row is a past trace → no blocker", () => {
    const input = wakeupInput();
    const adversarial = { ...wakeupRow(), claimedAt: WAKEUP_T0_ISO } as unknown as WakeRow;
    input.wakeups = [adversarial];
    expect(check(input)).toEqual([]);
  });

  it("an unproven record on a LIVE row surfaces the liveness blocker first — rule 6 shadowed by precedence", () => {
    // live 행은 규칙 4(자기 비종말) 또는 규칙 5(활성 상대)가 규칙 6 보다 먼저 발화한다(행당 최대
    // 1개 blocker) — 게이팅 후 wakeup_terminal_record_unproven 은 단독으로 도달 불가다.
    const queuedInput = wakeupInput();
    queuedInput.wakeups = [{ ...wakeupRow({ status: "queued" }), requestedAt: null } as unknown as WakeRow];
    expect(check(queuedInput)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_not_terminal")]);
    const neighborInput = wakeupInput();
    neighborInput.wakeups = [wakeupRow({ requestedAt: new Date("not-a-date") })];
    neighborInput.heartbeats = [hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-1" })];
    expect(check(neighborInput)).toEqual([
      blockers("active_work", "wakeup", "wake-1", "wakeup_linked_heartbeat_not_terminal"),
    ]);
  });

  it("accepts both null claimedAt and a finite claimedAt (no extra ordering constraint)", () => {
    const nullClaim = wakeupInput();
    nullClaim.wakeups = [wakeupRow({ claimedAt: null })];
    expect(check(nullClaim)).toEqual([]);
    const claimed = wakeupInput();
    claimed.wakeups = [wakeupRow({ claimedAt: T1, finishedAt: T1 })];
    expect(check(claimed)).toEqual([]);
  });

  it("rules 4-6 never produce heartbeat blockers — a linked-history heartbeat without dates is fine here", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow()];
    input.heartbeats = [hbRow({ id: "hb-1", startedAt: null, finishedAt: null, settledAt: null, wakeupRequestId: null })];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — ignored fields (no prose/generation filtering)", () => {
  it("contradictory payload/reason/error/triggerDetail prose never changes the verdict", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({
      reason: "still running", error: "queued again", triggerDetail: "not finished",
      payload: { status: "running", workflowRunId: "run-1" },
    })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", contextSnapshot: { status: "running" } })];
    expect(check(input)).toEqual([]);
  });

  it("old generations and other workflowRunId values are not compared or filtered", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({
      workflowRunId: "run-ancient", workflowStepRunId: "step-ancient", workflowExecutionGeneration: 0,
    })];
    expect(check(input)).toEqual([]);
  });
});

describe("checkObservedWakeupConflicts — purity and determinism", () => {
  it("never mutates caller arrays or rows", () => {
    const input = wakeupInput();
    const wake = wakeupRow({ status: "coalesced", runId: "hb-1" });
    const beat = hbRow({ id: "hb-1", status: "running", wakeupRequestId: "wake-1" });
    const wakeups = [wake];
    const heartbeats = [beat];
    input.wakeups = wakeups;
    input.heartbeats = heartbeats;
    const wakeBefore = { ...wake };
    const beatBefore = { ...beat };
    void check(input);
    expect(input.wakeups).toEqual([wakeBefore]);
    expect(input.heartbeats).toEqual([beatBefore]);
    expect(input.wakeups).toBe(wakeups);
    expect(input.heartbeats).toBe(heartbeats);
  });

  it("sorts multiple blockers codepoint-ascending without joining delimiter-looking ids into keys", () => {
    // 2026-10-22 liveness 교정: 4개 blocker 정렬을 계속 검증하려면 모든 행이 live 여야 한다.
    const input = wakeupInput();
    input.wakeups = [
      wakeupRow({ id: "wake|x", companyId: OTHER_COMPANY, status: "queued" }),
      wakeupRow({ id: "wake", companyId: OTHER_COMPANY, status: "queued" }),
    ];
    input.heartbeats = [
      hbRow({ id: "hb|x", companyId: OTHER_COMPANY, status: "running" }),
      hbRow({ id: "hb", companyId: OTHER_COMPANY, status: "running" }),
    ];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "heartbeat", "hb|x", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake|x", "wakeup_scope_mismatch"),
    ]);
  });
});
