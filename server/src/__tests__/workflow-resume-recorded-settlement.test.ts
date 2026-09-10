import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptedSettlementRecords,
  settlementFinalizationRow,
  settlementHeartbeatRow,
  settlementStageRow,
  type SettlementRecords,
} from "./helpers/workflow-resume-settlement-fixture.js";
import {
  checkRecordedHeartbeatSettlements,
  type RecordedSettlementBlocker,
  type RecordedSettlementInput,
} from "../services/workflow/resume/recorded-settlement.js";

/**
 * [purpose] Task5c3a recorded heartbeat settlement verification — pure checker contract tests
 *   (accepted paths + ordered rules 1-4). Full DB-row typed factories only (no `as any`);
 *   rule 5 stage policy + determinism/immutability/diagnostics live in the boundaries file;
 *   real embedded-PG reader integration lives in workflow-resume-recorded-settlement-db.test.ts.
 *   Empty blockers proves ONLY that the records passed THIS check — never full quiescence or
 *   resume eligibility, and absent history never certifies no prior work.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSION = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const HB = "44444444-4444-4444-8444-444444444444";
const HB2 = "55555555-5555-5555-8555-555555555555";
const SCOPE = { companyId: COMPANY, missionId: MISSION, workflowRunId: RUN, startStepId: "resume-step-a" };
const EXPIRED = new Date("2020-01-01T00:00:00.000Z");

function base(): SettlementRecords {
  return acceptedSettlementRecords({ id: HB, companyId: COMPANY });
}

function asInput(
  records: SettlementRecords,
  overrides?: Partial<Pick<RecordedSettlementInput, "heartbeats" | "finalizations" | "finalizationSteps">>,
): RecordedSettlementInput {
  return {
    scope: SCOPE,
    heartbeats: [records.heartbeat],
    finalizations: [records.finalization],
    finalizationSteps: [...records.stages],
    ...overrides,
  };
}

function check(
  records: SettlementRecords,
  overrides?: Partial<Pick<RecordedSettlementInput, "heartbeats" | "finalizations" | "finalizationSteps">>,
): RecordedSettlementBlocker[] {
  return checkRecordedHeartbeatSettlements(asInput(records, overrides));
}

function expectSingleBlocked(
  records: SettlementRecords,
  code: RecordedSettlementBlocker["code"],
  reason: RecordedSettlementBlocker["reason"],
): void {
  expect(check(records)).toEqual([{ code, heartbeatRunId: HB, reason }]);
}

describe("checkRecordedHeartbeatSettlements — accepted recorded settlements", () => {
  it("accepts all four terminal outcomes when heartbeat/parent/stages agree", () => {
    for (const outcome of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(check(acceptedSettlementRecords({ id: HB, companyId: COMPANY, terminalOutcome: outcome }))).toEqual([]);
    }
  });

  it("accepts a valid pending unleased v1 parent (the writer's normal post-settlement state)", () => {
    const records = base();
    expect(records.finalization.state).toBe("pending");
    expect(records.finalization.finalizerOwner).toBeNull();
    expect(records.finalization.finalizerLeaseToken).toBeNull();
    expect(records.finalization.finalizerLeaseExpiresAt).toBeNull();
    expect(check(records)).toEqual([]);
  });

  it("accepts a nonnull historical processPid without OS probing", () => {
    const records = base();
    records.heartbeat.processPid = 4242;
    expect(check(records)).toEqual([]);
  });

  it("returns [] for empty input — explicitly NOT a full quiescence/eligibility proof", () => {
    expect(
      checkRecordedHeartbeatSettlements({ scope: SCOPE, heartbeats: [], finalizations: [], finalizationSteps: [] }),
    ).toEqual([]);
  });
});

describe("checkRecordedHeartbeatSettlements — rule 1 scope/link integrity", () => {
  it.each([
    ["heartbeat company mismatch", (r: SettlementRecords) => void (r.heartbeat.companyId = OTHER_COMPANY)],
    ["associated parent company mismatch", (r: SettlementRecords) => void (r.finalization.companyId = OTHER_COMPANY)],
    ["associated stage company mismatch", (r: SettlementRecords) => void (r.stages[0]!.companyId = OTHER_COMPANY)],
  ])("blocks %s as scope_mismatch", (_label, mutate) => {
    const records = base();
    mutate(records);
    expectSingleBlocked(records, "scope_mismatch", "settlement_scope_mismatch");
  });

  it("blocks duplicate parent rows (parent id ambiguity) as scope_mismatch even when a later rule would fire", () => {
    const records = base();
    records.heartbeat.status = "running"; // rule 2 would also fire — rule 1 must win
    const duplicate = settlementFinalizationRow({ ...records.finalization });
    expect(check(records, { finalizations: [records.finalization, duplicate] })).toEqual([
      { code: "scope_mismatch", heartbeatRunId: HB, reason: "settlement_scope_mismatch" },
    ]);
  });

  it("reports orphan finalizations under that row's own heartbeatRunId, de-duplicated", () => {
    const records = base();
    const orphan = settlementFinalizationRow({ heartbeatRunId: "orphan-parent-hb" });
    const duplicateOrphan = settlementFinalizationRow({ heartbeatRunId: "orphan-parent-hb" });
    expect(check(records, { finalizations: [records.finalization, orphan, duplicateOrphan] })).toEqual([
      { code: "scope_mismatch", heartbeatRunId: "orphan-parent-hb", reason: "settlement_scope_mismatch" },
    ]);
  });

  it("reports orphan finalization stages under the stage row's own heartbeatRunId", () => {
    const records = base();
    const orphan = settlementStageRow({
      heartbeatRunId: "orphan-stage-hb",
      heartbeatRunFinalizationId: "missing-parent-id",
      idempotencyKey: "orphan-stage",
    });
    expect(check(records, { finalizationSteps: [...records.stages, orphan] })).toEqual([
      { code: "scope_mismatch", heartbeatRunId: "orphan-stage-hb", reason: "settlement_scope_mismatch" },
    ]);
  });

  it("blocks a stage whose heartbeat and parent name different heartbeats on both collected sides", () => {
    const r1 = base();
    const r2 = acceptedSettlementRecords({ id: HB2, companyId: COMPANY });
    const cross = settlementStageRow({
      companyId: COMPANY,
      heartbeatRunId: HB2,
      heartbeatRunFinalizationId: r1.finalization.id,
      idempotencyKey: "cross-link",
    });
    expect(
      checkRecordedHeartbeatSettlements({
        scope: SCOPE,
        heartbeats: [r1.heartbeat, r2.heartbeat],
        finalizations: [r1.finalization, r2.finalization],
        finalizationSteps: [...r1.stages, ...r2.stages, cross],
      }),
    ).toEqual([
      { code: "scope_mismatch", heartbeatRunId: HB, reason: "settlement_scope_mismatch" },
      { code: "scope_mismatch", heartbeatRunId: HB2, reason: "settlement_scope_mismatch" },
    ]);
  });

  it("rule 1 precedes rule 2 — nonterminal heartbeat with scope mismatch reports scope_mismatch", () => {
    const records = base();
    records.heartbeat.status = "running";
    records.heartbeat.companyId = OTHER_COMPANY;
    expectSingleBlocked(records, "scope_mismatch", "settlement_scope_mismatch");
  });
});

describe("checkRecordedHeartbeatSettlements — rule 2 terminal status", () => {
  it.each(["running", "queued", "mystery_unknown_status"])(
    "blocks nonterminal/unknown status %s as heartbeat_not_terminal",
    (status) => {
      const records = base();
      records.heartbeat.status = status;
      expectSingleBlocked(records, "active_work", "heartbeat_not_terminal");
    },
  );
});

describe("checkRecordedHeartbeatSettlements — rule 3 durable settlement proof", () => {
  const cases: Array<[string, (records: SettlementRecords) => void]> = [
    ["finalizationVersion 0", (r) => void (r.heartbeat.finalizationVersion = 0)],
    ["unknown finalizationVersion 2", (r) => void (r.heartbeat.finalizationVersion = 2)],
    ["settledAt null", (r) => void (r.heartbeat.settledAt = null)],
    ["settledAt invalid date", (r) => void (r.heartbeat.settledAt = new Date("not-a-date"))],
    ["executorOwnerReleasedAt null", (r) => void (r.heartbeat.executorOwnerReleasedAt = null)],
    ["executorOwnerReleasedAt invalid date", (r) => void (r.heartbeat.executorOwnerReleasedAt = new Date("nope"))],
    ["terminalDecidedAt null", (r) => void (r.heartbeat.terminalDecidedAt = null)],
    ["terminalDecidedAt invalid date", (r) => void (r.heartbeat.terminalDecidedAt = new Date("nope"))],
    ["terminalOutcome null", (r) => void (r.heartbeat.terminalOutcome = null)],
    ["terminalOutcome nonterminal", (r) => void (r.heartbeat.terminalOutcome = "completed")],
    ["terminalOutcome != status", (r) => void (r.heartbeat.terminalOutcome = "failed")],
    ["expired owner lease never substitutes release proof", (r) => {
      r.heartbeat.executorOwnerReleasedAt = null;
      r.heartbeat.executorOwnerLeaseExpiresAt = EXPIRED;
    }],
  ];

  it.each(cases)("blocks %s as settlement_unproven", (_label, mutate) => {
    const records = base();
    mutate(records);
    expectSingleBlocked(records, "active_work", "settlement_unproven");
  });
});

describe("checkRecordedHeartbeatSettlements — rule 4 finalization identity", () => {
  it("blocks a missing parent as finalization_identity_unproven", () => {
    // parent 행이 하나도 없는 순수 미싱 케이스 — stage 까지 같이 비어야 rule 1 링크 오염과 구분된다.
    expect(check(base(), { finalizations: [], finalizationSteps: [] })).toEqual([
      { code: "active_work", heartbeatRunId: HB, reason: "finalization_identity_unproven" },
    ]);
  });

  it("blocks a stage whose parent id resolves to nothing as scope_mismatch (fail-closed link defense)", () => {
    const records = base();
    records.stages = [records.stages[0]!];
    expect(check(records, { finalizations: [] })).toEqual([
      { code: "scope_mismatch", heartbeatRunId: HB, reason: "settlement_scope_mismatch" },
    ]);
  });

  const cases: Array<[string, (records: SettlementRecords) => void]> = [
    ["parent finalizationVersion 0", (r) => void (r.finalization.finalizationVersion = 0)],
    ["parent unknown finalizationVersion 2", (r) => void (r.finalization.finalizationVersion = 2)],
    ["parent executionEpoch mismatch", (r) => void (r.finalization.executionEpoch = r.heartbeat.executionEpoch + 1)],
    ["heartbeat executionEpoch null", (r) => void (r.heartbeat.executionEpoch = null)],
    ["heartbeat executionEpoch negative", (r) => void (r.heartbeat.executionEpoch = -1)],
    ["heartbeat executionEpoch non-integer", (r) => void (r.heartbeat.executionEpoch = 1.5)],
    ["heartbeat executionEpoch unsafe", (r) => void (r.heartbeat.executionEpoch = Number.MAX_SAFE_INTEGER + 1)],
    ["executionToken mismatch", (r) => void (r.finalization.executionToken = randomUUID())],
    ["heartbeat executionToken empty", (r) => void (r.heartbeat.executionToken = "")],
    ["heartbeat executionToken null", (r) => void (r.heartbeat.executionToken = null)],
    ["parent terminalOutcome mismatch", (r) => void (r.finalization.terminalOutcome = "failed")],
    ["parent terminalDecisionSource mismatch", (r) => void (r.finalization.terminalDecisionSource = "other-source")],
    ["heartbeat terminalDecisionSource empty", (r) => void (r.heartbeat.terminalDecisionSource = "")],
    ["parent state leased", (r) => void (r.finalization.state = "leased")],
    ["parent state blocked_noncompensable", (r) => void (r.finalization.state = "blocked_noncompensable")],
    ["parent state completed (settlement never writes this)", (r) => void (r.finalization.state = "completed")],
    ["parent state unknown", (r) => void (r.finalization.state = "mystery_state")],
    ["parent finalizerOwner nonnull", (r) => void (r.finalization.finalizerOwner = "finalizer-1")],
    ["parent finalizerLeaseToken nonnull", (r) => void (r.finalization.finalizerLeaseToken = randomUUID())],
    ["parent finalizerLeaseExpiresAt nonnull even expired", (r) => void (r.finalization.finalizerLeaseExpiresAt = EXPIRED)],
  ];

  it.each(cases)("blocks %s as finalization_identity_unproven", (_label, mutate) => {
    const records = base();
    mutate(records);
    expectSingleBlocked(records, "active_work", "finalization_identity_unproven");
  });

  it("retains finalizerLeaseEpoch as a historical counter that alone does not block", () => {
    const records = base();
    records.finalization.finalizerLeaseEpoch = 7;
    expect(check(records)).toEqual([]);
  });

  it("accepts a parent whose execution identity exactly matches the heartbeat", () => {
    const records = base();
    expect(records.finalization.executionEpoch).toBe(records.heartbeat.executionEpoch);
    expect(records.finalization.executionToken).toBe(records.heartbeat.executionToken);
    expect(records.finalization.terminalOutcome).toBe(records.heartbeat.terminalOutcome);
    expect(records.finalization.terminalDecisionSource).toBe(records.heartbeat.terminalDecisionSource);
    expect(check(records)).toEqual([]);
  });

  it("does not mutate caller arrays when sorting the copy for inspection", () => {
    const records = base();
    const heartbeats = [records.heartbeat];
    const finalizations = [records.finalization];
    const finalizationSteps = [...records.stages];
    void checkRecordedHeartbeatSettlements({ scope: SCOPE, heartbeats, finalizations, finalizationSteps });
    expect(heartbeats.map((row) => row.id)).toEqual([HB]);
    expect(finalizations.map((row) => row.heartbeatRunId)).toEqual([HB]);
    expect(finalizationSteps).toHaveLength(records.stages.length);
  });

  it("accepts a valid recorded settlement with settlementHeartbeatRow built directly (full-row typed)", () => {
    const records = base();
    const rebuilt = settlementHeartbeatRow({ ...records.heartbeat });
    expect(check({ ...records, heartbeat: rebuilt }, { heartbeats: [rebuilt] })).toEqual([]);
  });
});
