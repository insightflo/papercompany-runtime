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
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ companyId: OTHER_COMPANY })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch")]);
  });

  it("blocks a heartbeat whose own company is out of scope", () => {
    const input = wakeupInput();
    input.heartbeats = [hbRow({ id: "hb-1", companyId: OTHER_COMPANY })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch")]);
  });

  it("blocks a wake mission mismatch while null mission stays legacy-allowed", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ missionId: "mission-2" })];
    expect(check(input)).toEqual([blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch")]);
    const nullMission = wakeupInput();
    nullMission.wakeups = [wakeupRow({ missionId: null })];
    expect(check(nullMission)).toEqual([]);
  });

  it("a cross-company linked heartbeat contaminates its wake (direct adjacency only)", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", wakeupRequestId: null, companyId: OTHER_COMPANY })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
  });

  it("an agentId mismatch on a FORWARD edge blocks both identities", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ agentId: "agent-1", status: "coalesced", runId: "hb-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", agentId: "agent-2", wakeupRequestId: null })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
  });

  it("an agentId mismatch on a REVERSE edge blocks both identities", () => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow({ agentId: "agent-1" })];
    input.heartbeats = [hbRow({ id: "hb-1", status: "succeeded", agentId: "agent-2", wakeupRequestId: "wake-1" })];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb-1", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake-1", "wakeup_scope_mismatch"),
    ]);
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

  it("blocks a null requestedAt injected via runtime adversarial cast only", () => {
    const input = wakeupInput();
    const adversarial = { ...wakeupRow(), requestedAt: null } as unknown as WakeRow;
    input.wakeups = [adversarial];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_terminal_record_unproven")]);
  });

  it.each([
    ["invalid requestedAt", { requestedAt: new Date("not-a-date") }],
    ["null finishedAt", { finishedAt: null }],
    ["invalid finishedAt", { finishedAt: new Date("nope") }],
    ["finishedAt earlier than requestedAt", { requestedAt: T1, finishedAt: T0 }],
    ["invalid claimedAt", { claimedAt: new Date("bad") }],
  ] as Array<[string, Partial<WakeRow>]>)("blocks %s as wakeup_terminal_record_unproven", (_label, overrides) => {
    const input = wakeupInput();
    input.wakeups = [wakeupRow(overrides)];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_terminal_record_unproven")]);
  });

  it("rejects a non-Date claimedAt string — no date coercion or string acceptance", () => {
    const input = wakeupInput();
    const adversarial = { ...wakeupRow(), claimedAt: WAKEUP_T0_ISO } as unknown as WakeRow;
    input.wakeups = [adversarial];
    expect(check(input)).toEqual([blockers("active_work", "wakeup", "wake-1", "wakeup_terminal_record_unproven")]);
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
    const input = wakeupInput();
    input.wakeups = [
      wakeupRow({ id: "wake|x", companyId: OTHER_COMPANY }),
      wakeupRow({ id: "wake", companyId: OTHER_COMPANY }),
    ];
    input.heartbeats = [
      hbRow({ id: "hb|x", companyId: OTHER_COMPANY }),
      hbRow({ id: "hb", companyId: OTHER_COMPANY }),
    ];
    expect(check(input)).toEqual([
      blockers("scope_mismatch", "heartbeat", "hb", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "heartbeat", "hb|x", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake", "wakeup_scope_mismatch"),
      blockers("scope_mismatch", "wakeup", "wake|x", "wakeup_scope_mismatch"),
    ]);
  });
});
