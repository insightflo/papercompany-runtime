import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptedSettlementRecords,
  settlementStageRow,
  type SettlementRecords,
} from "./helpers/workflow-resume-settlement-fixture.js";
import {
  checkRecordedHeartbeatSettlements,
  type RecordedSettlementBlocker,
  type RecordedSettlementInput,
} from "../services/workflow/resume/recorded-settlement.js";
import { C_STAGE, O_STAGE, Q_STAGE, STAGE_CLASS } from "../services/heartbeat-finalization/stage-classifier.js";

/**
 * [purpose] Task5c3a pure checker boundaries — rule 5 recorded-stage policy (real classifier
 *   required Q/C coverage, known-extra kinds, duplicates in both array orders, class/state/lease
 *   gates), plus determinism, caller-array immutability, frozen inputs and diagnostics hygiene.
 *   Full row typed factories only; embedded-PG integration is in the -db test file.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const HB = "44444444-4444-4444-8444-444444444444";
const HB2 = "55555555-5555-5555-8555-555555555555";
const SCOPE = { companyId: COMPANY, missionId: MISSION, workflowRunId: RUN, startStepId: "resume-step-a" };
const EXPIRED = new Date("2020-01-01T00:00:00.000Z");
const STAGES_BLOCKED: RecordedSettlementBlocker = {
  code: "active_work",
  heartbeatRunId: HB,
  reason: "finalization_stages_unproven",
};

function base(): SettlementRecords {
  // issueId 를 세팅해 workflow_step+issue 가 요구하는 4Q + 2C(workflow evidence + issue promotion) 전체가
  //   실제 분류기에서 required 로 나오는 기준선을 만든다 스코프 의존 required 검증의 전제.
  return acceptedSettlementRecords({ id: HB, companyId: COMPANY, issueId: "issue-1" });
}

function base3(): SettlementRecords {
  return acceptedSettlementRecords({
    id: HB,
    companyId: COMPANY,
    executionScopeKind: "automation_nonworkflow",
    issueId: null,
  });
}

function check(
  records: SettlementRecords,
  overrides?: Partial<Pick<RecordedSettlementInput, "heartbeats" | "finalizations" | "finalizationSteps">>,
): RecordedSettlementBlocker[] {
  return checkRecordedHeartbeatSettlements({
    scope: SCOPE,
    heartbeats: [records.heartbeat],
    finalizations: [records.finalization],
    finalizationSteps: [...records.stages],
    ...overrides,
  });
}

function extraStage(records: SettlementRecords, fields: Parameters<typeof settlementStageRow>[0]) {
  return settlementStageRow({
    companyId: COMPANY,
    heartbeatRunId: HB,
    heartbeatRunFinalizationId: records.finalization.id,
    ...fields,
  });
}

describe("checkRecordedHeartbeatSettlements — rule 5 recorded stage policy", () => {
  // 실제 분류기 기준 workflow_step+issue 스코프의 required 전체(4Q + 2C).
  const REQUIRED_KINDS = [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped,
    Q_STAGE.missionRuntimeIdle, C_STAGE.workflowEvidenceSync, C_STAGE.issuePromotion];

  it.each(REQUIRED_KINDS)("blocks missing required workflow_step+issue stage %s", (kind) => {
    const records = base();
    records.stages = records.stages.filter((stage) => stage.stageKind !== kind);
    expect(check(records)).toEqual([STAGES_BLOCKED]);
  });

  it("accepts nonmission no-issue scope with exactly base3 Q (real classifier scope dependence)", () => {
    const records = base3();
    expect(records.stages.map((stage) => stage.stageKind).sort()).toEqual(
      [Q_STAGE.executorQuiescence, Q_STAGE.runtimeServicesStopped, Q_STAGE.workspaceOperationsSettled].sort(),
    );
    expect(check(records)).toEqual([]);
  });

  it("accepts an extra known nonrequired Q done row (writer records mission_runtime_idle even nonmission)", () => {
    const records = base3();
    const extra = extraStage(records, {
      stageKind: Q_STAGE.missionRuntimeIdle,
      stageClass: STAGE_CLASS.quiescence,
      state: "done",
      idempotencyKey: "extra-known-q",
    });
    expect(check(records, { finalizationSteps: [...records.stages, extra] })).toEqual([]);
  });

  it("blocks an optional-to-scope known Q row that is not done", () => {
    const records = base3();
    const leased = extraStage(records, {
      stageKind: Q_STAGE.missionRuntimeIdle,
      stageClass: STAGE_CLASS.quiescence,
      state: "leased",
      idempotencyKey: "extra-known-q-not-done",
    });
    expect(check(records, { finalizationSteps: [...records.stages, leased] })).toEqual([STAGES_BLOCKED]);
  });

  it.each([
    ["absent", null, true],
    ["done", "done", true],
    ["dead_letter", "dead_letter", true],
    ["pending", "pending", false],
  ])("optional O stage %s → %s", (_label, state, accepted) => {
    const records = base();
    if (state === null) {
      expect(check(records)).toEqual([]);
      return;
    }
    const optional = extraStage(records, {
      stageKind: O_STAGE.livePublication,
      stageClass: STAGE_CLASS.optional,
      state,
      idempotencyKey: "optional-o",
    });
    expect(check(records, { finalizationSteps: [...records.stages, optional] })).toEqual(
      accepted ? [] : [STAGES_BLOCKED],
    );
  });

  it("blocks a Q duplicate done+dead_letter pair in BOTH array orders", () => {
    const records = base();
    const dead = extraStage(records, {
      stageKind: Q_STAGE.executorQuiescence,
      stageClass: STAGE_CLASS.quiescence,
      state: "dead_letter",
      idempotencyKey: "q-dead-dup",
    });
    expect(check(records, { finalizationSteps: [...records.stages, dead] })).toEqual([STAGES_BLOCKED]);
    expect(check(records, { finalizationSteps: [dead, ...records.stages] })).toEqual([STAGES_BLOCKED]);
  });

  it("blocks pending/leased duplicate Q and C rows despite a successful twin", () => {
    const records = base();
    const leasedQ = extraStage(records, {
      stageKind: Q_STAGE.executorQuiescence,
      stageClass: STAGE_CLASS.quiescence,
      state: "leased",
      idempotencyKey: "q-leased-dup",
    });
    expect(check(records, { finalizationSteps: [...records.stages, leasedQ] })).toEqual([STAGES_BLOCKED]);
    const pendingC = extraStage(records, {
      stageKind: C_STAGE.workflowEvidenceSync,
      stageClass: STAGE_CLASS.compensable,
      state: "pending",
      idempotencyKey: "c-pending-dup",
    });
    expect(check(records, { finalizationSteps: [...records.stages, pendingC] })).toEqual([STAGES_BLOCKED]);
  });

  it("accepts C equivalent_failed; blocks Q equivalent_failed and Q dead_letter", () => {
    const cEquivalent = base();
    cEquivalent.stages = cEquivalent.stages.map((stage) =>
      stage.stageKind === C_STAGE.issuePromotion ? { ...stage, state: "equivalent_failed" } : stage);
    expect(check(cEquivalent)).toEqual([]);

    const qEquivalent = base();
    qEquivalent.stages = qEquivalent.stages.map((stage) =>
      stage.stageKind === Q_STAGE.executorQuiescence ? { ...stage, state: "equivalent_failed" } : stage);
    expect(check(qEquivalent)).toEqual([STAGES_BLOCKED]);

    const qDead = base();
    qDead.stages = qDead.stages.map((stage) =>
      stage.stageKind === Q_STAGE.runtimeServicesStopped ? { ...stage, state: "dead_letter" } : stage);
    expect(check(qDead)).toEqual([STAGES_BLOCKED]);
  });

  it.each([
    ["unknown stage kind", { stageKind: "ledger", stageClass: STAGE_CLASS.quiescence, state: "done" }],
    ["known Q kind with C class", { stageKind: Q_STAGE.executorQuiescence, stageClass: STAGE_CLASS.compensable, state: "done" }],
    ["known O kind with C class", { stageKind: O_STAGE.livePublication, stageClass: STAGE_CLASS.compensable, state: "done" }],
    ["known C kind with O class", { stageKind: C_STAGE.issuePromotion, stageClass: STAGE_CLASS.optional, state: "done" }],
  ])("blocks %s", (_label, fields) => {
    const records = base();
    const bad = extraStage(records, { ...fields, idempotencyKey: "bad-mapping" });
    expect(check(records, { finalizationSteps: [...records.stages, bad] })).toEqual([STAGES_BLOCKED]);
  });

  it.each([
    ["leaseOwner", (stage: SettlementRecords["stages"][number]) => void (stage.leaseOwner = "stage-owner")],
    ["leaseToken", (stage: SettlementRecords["stages"][number]) => void (stage.leaseToken = randomUUID())],
    ["leaseExpiresAt", (stage: SettlementRecords["stages"][number]) => void (stage.leaseExpiresAt = EXPIRED)],
  ])("blocks nonnull stage %s even when the lease is expired", (_label, mutate) => {
    const records = base();
    mutate(records.stages[0]!);
    expect(check(records)).toEqual([STAGES_BLOCKED]);
  });

  it("accepts a stage leaseEpoch counter alone (historical, not active work)", () => {
    const records = base();
    records.stages[0]!.leaseEpoch = 7;
    expect(check(records)).toEqual([]);
  });
});

describe("checkRecordedHeartbeatSettlements — determinism, immutability, diagnostics", () => {
  it("does not omit old-generation/legacy heartbeats from inspection", () => {
    const records = base();
    const oldRun = acceptedSettlementRecords({ id: HB2, companyId: COMPANY, executionEpoch: 0 });
    oldRun.heartbeat.workflowExecutionGeneration = 0;
    oldRun.heartbeat.status = "running";
    expect(
      checkRecordedHeartbeatSettlements({
        scope: SCOPE,
        heartbeats: [records.heartbeat, oldRun.heartbeat],
        finalizations: [records.finalization, oldRun.finalization],
        finalizationSteps: [...records.stages, ...oldRun.stages],
      }),
    ).toEqual([{ code: "active_work", heartbeatRunId: HB2, reason: "heartbeat_not_terminal" }]);
  });

  it("produces identical id-sorted blockers regardless of input permutation", () => {
    const first = acceptedSettlementRecords({ id: HB, companyId: COMPANY });
    first.heartbeat.settledAt = null;
    const second = acceptedSettlementRecords({ id: HB2, companyId: COMPANY });
    second.heartbeat.status = "queued";
    const assemble = (reverse: boolean) => ({
      scope: SCOPE,
      heartbeats: reverse ? [second.heartbeat, first.heartbeat] : [first.heartbeat, second.heartbeat],
      finalizations: reverse ? [second.finalization, first.finalization] : [first.finalization, second.finalization],
      finalizationSteps: reverse ? [...second.stages, ...first.stages] : [...first.stages, ...second.stages],
    });
    const expected = [
      { code: "active_work", heartbeatRunId: HB, reason: "settlement_unproven" },
      { code: "active_work", heartbeatRunId: HB2, reason: "heartbeat_not_terminal" },
    ];
    expect(checkRecordedHeartbeatSettlements(assemble(false))).toEqual(expected);
    expect(checkRecordedHeartbeatSettlements(assemble(true))).toEqual(expected);
  });

  it("never mutates caller arrays even when sorting the copy would be required", () => {
    const late = acceptedSettlementRecords({ id: HB, companyId: COMPANY });
    late.heartbeat.status = "running";
    const early = acceptedSettlementRecords({ id: "4fffffff-ffff-4fff-8fff-ffffffffffff", companyId: COMPANY });
    early.heartbeat.settledAt = null;
    const heartbeats = [late.heartbeat, early.heartbeat];
    const finalizations = [late.finalization, early.finalization];
    const finalizationSteps = [...late.stages, ...early.stages];
    const result = checkRecordedHeartbeatSettlements({ scope: SCOPE, heartbeats, finalizations, finalizationSteps });
    // codepoint 순: "4444…"(late) < "4fff…"(early) — caller 배열 순서와 무관하게 정렬된다.
    expect(result.map((blocker) => blocker.heartbeatRunId)).toEqual([late.heartbeat.id, early.heartbeat.id]);
    expect(heartbeats.map((row) => row.id)).toEqual([late.heartbeat.id, early.heartbeat.id]);
    expect(finalizations.map((row) => row.heartbeatRunId)).toEqual([late.heartbeat.id, early.heartbeat.id]);
    expect(finalizationSteps).toHaveLength(late.stages.length + early.stages.length);
  });

  it("preserves frozen inputs (deep-frozen graph) without throwing", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value as object).forEach(deepFreeze);
      }
      return value;
    };
    const records = base();
    const input = deepFreeze({
      scope: SCOPE,
      heartbeats: [records.heartbeat],
      finalizations: [records.finalization],
      finalizationSteps: [...records.stages],
    });
    expect(checkRecordedHeartbeatSettlements(input)).toEqual([]);
    expect(Object.isFrozen(input.heartbeats)).toBe(true);
    expect(Object.isFrozen(input.heartbeats[0])).toBe(true);
    expect(Object.isFrozen(input.finalizationSteps)).toBe(true);
  });

  it("diagnostics carry exactly code/heartbeatRunId/reason; log/payload success strings never leak or help", () => {
    const accepted = base();
    accepted.heartbeat.stdoutExcerpt = "SUCCESS: everything done SECRET-TOKEN";
    accepted.heartbeat.stderrExcerpt = "SECRET-TOKEN trace";
    accepted.heartbeat.error = "SECRET-TOKEN boom";
    accepted.heartbeat.resultJson = { payload: "all stages done successfully" };
    expect(check(accepted)).toEqual([]);

    const blocked = base();
    blocked.heartbeat.stdoutExcerpt = "looks done successfully";
    blocked.stages = blocked.stages.filter((stage) => stage.stageKind !== C_STAGE.issuePromotion);
    const result = check(blocked);
    expect(result).toEqual([STAGES_BLOCKED]);
    expect(Object.keys(result[0]!).sort()).toEqual(["code", "heartbeatRunId", "reason"]);
    expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN");
  });
});
