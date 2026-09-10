import { describe, expect, it } from "vitest";
import {
  acceptedSettlementRecords,
  type SettlementFinalizationRow,
  type SettlementHeartbeatRow,
  type SettlementStageRow,
} from "./helpers/workflow-resume-settlement-fixture.js";
import {
  checkRecordedHeartbeatSettlements,
  type RecordedSettlementBlocker,
  type RecordedSettlementInput,
} from "../services/workflow/resume/recorded-settlement.js";

/**
 * [purpose] Task5c3a fix1 — parent-reviewed duplicate parent ID regression. Defect: the
 *   last-wins parentById map erases duplicate parent.id rows across DIFFERENT heartbeatRunId,
 *   so rule 1 (parents.length>1) only sees same-heartbeat duplicates. With one input order the
 *   second heartbeat was even ACCEPTED on the last-wins lookup's authority. Contract under
 *   test: parent ids ambiguous across heartbeats must be rejected by rule 1 for EVERY affected
 *   heartbeat (BEFORE lower rules), and stageLinkConflicted must treat an ambiguous referenced
 *   parent id as conflicted. Expected exact output, any order, any stage subset: one
 *   scope_mismatch/settlement_scope_mismatch per heartbeat id, sorted. Uses the existing typed
 *   acceptedSettlementRecords fixture only (no casts, no `as any`). Empty blockers still proves
 *   ONLY this check — never full quiescence or resume eligibility.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const HB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCOPE = {
  companyId: COMPANY,
  missionId: "22222222-2222-4222-8222-222222222222",
  workflowRunId: "33333333-3333-4333-8333-333333333333",
  startStepId: "resume-step-a",
};

/** Exact expected result for the shared parent id: both heartbeats, rule 1, sorted by id. */
const SHARED_PARENT_BLOCKERS: RecordedSettlementBlocker[] = [
  { code: "scope_mismatch", heartbeatRunId: HB_A, reason: "settlement_scope_mismatch" },
  { code: "scope_mismatch", heartbeatRunId: HB_B, reason: "settlement_scope_mismatch" },
];

interface AmbiguousPair {
  heartbeatA: SettlementHeartbeatRow;
  heartbeatB: SettlementHeartbeatRow;
  parentA: SettlementFinalizationRow;
  parentB: SettlementFinalizationRow;
  stagesA: SettlementStageRow[];
  stagesB: SettlementStageRow[];
}

/** Two coherent heartbeat sets whose parents share ONE parent.id (B repointed to A's id). */
function ambiguousPair(): AmbiguousPair {
  const a = acceptedSettlementRecords({ id: HB_A, companyId: COMPANY });
  const b = acceptedSettlementRecords({ id: HB_B, companyId: COMPANY });
  const sharedParentId = a.finalization.id;
  const parentB = { ...b.finalization, id: sharedParentId };
  const stagesB = b.stages.map((stage) => ({ ...stage, heartbeatRunFinalizationId: sharedParentId }));
  return {
    heartbeatA: a.heartbeat,
    heartbeatB: b.heartbeat,
    parentA: a.finalization,
    parentB,
    stagesA: a.stages,
    stagesB,
  };
}

type StageSet = "none" | "a" | "b" | "both";

interface Permutation {
  parentOrder: 0 | 1;
  heartbeatOrder: 0 | 1;
  stageOrder: 0 | 1;
}

function buildInput(pair: AmbiguousPair, stageSet: StageSet, perm: Permutation): RecordedSettlementInput {
  const parents = perm.parentOrder === 0 ? [pair.parentA, pair.parentB] : [pair.parentB, pair.parentA];
  const heartbeats = perm.heartbeatOrder === 0
    ? [pair.heartbeatA, pair.heartbeatB]
    : [pair.heartbeatB, pair.heartbeatA];
  const pool =
    stageSet === "none" ? []
    : stageSet === "a" ? pair.stagesA
    : stageSet === "b" ? pair.stagesB
    : [...pair.stagesA, ...pair.stagesB];
  const finalizationSteps = perm.stageOrder === 0 ? [...pool] : [...pool].reverse();
  return { scope: SCOPE, heartbeats, finalizations: parents, finalizationSteps };
}

const ALL_PERMUTATIONS: Permutation[] = [0, 1].flatMap((parentOrder) =>
  [0, 1].flatMap((heartbeatOrder) => [0, 1].map((stageOrder) => ({ parentOrder, heartbeatOrder, stageOrder }) as Permutation)));

describe("checkRecordedHeartbeatSettlements — duplicate parent id across different heartbeats (fix1)", () => {
  for (const stageSet of ["none", "a", "b", "both"] as const) {
    it(`blocks both heartbeats as scope_mismatch for every parent/heartbeat/stage order (stages=${stageSet})`, () => {
      const pair = ambiguousPair();
      for (const perm of ALL_PERMUTATIONS) {
        expect(checkRecordedHeartbeatSettlements(buildInput(pair, stageSet, perm))).toEqual(SHARED_PARENT_BLOCKERS);
      }
    });
  }

  it("rule 1 ambiguity precedes lower rules — A running must still report scope_mismatch for both", () => {
    const pair = ambiguousPair();
    pair.heartbeatA.status = "running"; // rule 2 heartbeat_not_terminal would fire for A alone
    for (const perm of ALL_PERMUTATIONS) {
      expect(checkRecordedHeartbeatSettlements(buildInput(pair, "both", perm))).toEqual(SHARED_PARENT_BLOCKERS);
    }
  });

  it("accepts coherent A/B with DISTINCT parent ids in every order — same-kind distinct stage ids stay legal", () => {
    const a = acceptedSettlementRecords({ id: HB_A, companyId: COMPANY });
    const b = acceptedSettlementRecords({ id: HB_B, companyId: COMPANY });
    // Control sanity: both sets carry the same required kinds but disjoint stage row ids.
    const kindsA = new Set(a.stages.map((stage) => stage.stageKind));
    expect(kindsA.size).toBe(a.stages.length);
    expect(b.stages.every((stage) => kindsA.has(stage.stageKind))).toBe(true);
    const allStageIds = new Set([...a.stages, ...b.stages].map((stage) => stage.id));
    expect(allStageIds.size).toBe(a.stages.length + b.stages.length);
    const pair: AmbiguousPair = {
      heartbeatA: a.heartbeat,
      heartbeatB: b.heartbeat,
      parentA: a.finalization,
      parentB: b.finalization,
      stagesA: a.stages,
      stagesB: b.stages,
    };
    for (const perm of ALL_PERMUTATIONS) {
      // Accept requires each heartbeat's own full stage set (rule 5) — subset cases are not
      // accept paths even with distinct parents, so only "both" is a valid control here.
      expect(checkRecordedHeartbeatSettlements(buildInput(pair, "both", perm))).toEqual([]);
    }
  });
});
