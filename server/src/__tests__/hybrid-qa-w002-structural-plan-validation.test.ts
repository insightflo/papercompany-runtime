import { describe, expect, it } from "vitest";
import { validateDeclaredStructuralPlan } from "../services/missions/structural-materialization.js";

// W002 regression — Task #1: Pre-PLAN validation must see the EFFECTIVE
// materialized dependency graph (selected units filtered as materialization
// does, PLUS draft.steps merged dependency forms). A draft.steps that
// adds/removes/bypasses a structural gate or its producer must be rejected
// BEFORE PLAN-QA side effects. Ordinary (non-structural) plans are untouched.

describe("hybrid QA — W002 pre-PLAN effective merged dependency graph", () => {
  it("accepts a valid plan whose gate/producer deps live only in draft.steps", () => {
    // selectedExecutionUnits carry no explicit deps; draft.steps supply the
    // producer→gate→qa dependency chain. Materialization merges these, and
    // validation must accept the effective graph (not reject as unresolved).
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
      { id: "qa", title: "[QA] Semantic", sourceRef: { type: "mission_plan_unit", id: "qa" } },
    ];
    const draftSteps = [
      { unitId: "producer", dependencies: [] },
      { unitId: "gate", dependencies: ["producer"] },
      { unitId: "qa", dependencies: ["producer", "gate"] },
    ];
    expect(validateDeclaredStructuralPlan(units, draftSteps)).toEqual([]);
  });

  it("rejects a draft.steps that DROPS the gate→producer link (bypassed producer)", () => {
    // Gate declared to depend on nothing; the effective graph then has the gate
    // with zero non-gate producers, which is malformed structural topology.
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
    ];
    const draftSteps = [
      { unitId: "gate", dependencies: ["some-other-step"] }, // no producer link
    ];
    const errors = validateDeclaredStructuralPlan(units, draftSteps);
    expect(errors.some((e) => e.includes("exactly one non-gate producer"))).toBe(true);
  });

  it("rejects a draft.steps that drops the QA→gate link (gate omitted from QA)", () => {
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
      { id: "qa", title: "[QA] Semantic", sourceRef: { type: "mission_plan_unit", id: "qa" } },
    ];
    const draftSteps = [
      { unitId: "gate", dependencies: ["producer"] },
      { unitId: "qa", dependencies: ["producer"] }, // gate dropped
    ];
    const errors = validateDeclaredStructuralPlan(units, draftSteps);
    expect(errors.some((e) => e.includes("does not depend on structural gate"))).toBe(true);
  });

  it("rejects a draft.steps that ADDS an unresolved dependency ref", () => {
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
    ];
    const draftSteps = [
      { unitId: "gate", dependencies: ["producer", "ghost-from-draft-steps"] },
    ];
    const errors = validateDeclaredStructuralPlan(units, draftSteps);
    expect(errors.some((e) => /unresolved dependency/i.test(e) && e.includes("ghost-from-draft-steps"))).toBe(true);
  });

  it("treats non-structural plans unchanged (no errors) regardless of draft.steps", () => {
    const units = [
      { id: "a", title: "Action", sourceRef: { type: "mission_plan_unit", id: "a" } },
      { id: "q", title: "[QA] Review", sourceRef: { type: "mission_plan_unit", id: "q" } },
    ];
    const draftSteps = [
      { unitId: "q", dependencies: ["a", "bogus-ghost"] }, // would fail if structural
    ];
    expect(validateDeclaredStructuralPlan(units, draftSteps)).toEqual([]);
  });

  it("merges selected-unit deps and draft.steps deps for the same unit", () => {
    // selected-unit declares deps:["producer"]; draft.steps declares
    // deps:["gate"] for the same unit "qa". Effective should see BOTH.
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: ["producer"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
      { id: "qa", title: "[QA] Semantic", dependsOn: ["producer"],
        sourceRef: { type: "mission_plan_unit", id: "qa" } },
    ];
    const draftSteps = [{ unitId: "qa", dependencies: ["gate"] }];
    // effective qa deps = {producer, gate} → valid
    expect(validateDeclaredStructuralPlan(units, draftSteps)).toEqual([]);
  });

  it("Task1: a raw non-structural oversight unit pretending to be a producer is dropped, so a gate with only that 'producer' is rejected", () => {
    // The "producer" below is actually an oversight unit ([OVERSIGHT] / kind:oversight),
    // so materialization drops it. Pre-PLAN validation must apply the SAME filter,
    // leaving the gate with zero real producers → rejected (not silently valid).
    const units = [
      { id: "oversight-prod", title: "[OVERSIGHT] Approve", kind: "oversight",
        sourceRef: { type: "mission_plan_unit", id: "oversight-prod" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        dependsOn: ["oversight-prod"], sourceRef: { type: "mission_plan_unit", id: "gate" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => e.includes("exactly one non-gate producer"))).toBe(true);
  });

  it("Task1: oversight unit with a real producer still present is dropped without breaking the gate", () => {
    // oversight unit is dropped; the real producer remains, so the gate is valid.
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "oversight", title: "[OVERSIGHT] Review", kind: "oversight", dependsOn: ["producer"],
        sourceRef: { type: "mission_plan_unit", id: "oversight" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"],
        dependsOn: ["producer"], sourceRef: { type: "mission_plan_unit", id: "gate" } },
    ];
    expect(validateDeclaredStructuralPlan(units)).toEqual([]);
  });

  it("Task1: structural gates are never treated as oversight (retained even if id looks like oversight)", () => {
    const units = [
      { id: "producer", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "oversight-gate", type: "tool", qaType: "structural", toolNames: ["v"],
        dependsOn: ["producer"], sourceRef: { type: "mission_plan_unit", id: "oversight-gate" } },
    ];
    expect(validateDeclaredStructuralPlan(units)).toEqual([]);
  });
});
