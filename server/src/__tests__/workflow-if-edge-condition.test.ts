import { describe, expect, it } from "vitest";
import type { ConditionalEdge } from "../services/workflow/control-flow/types.js";
import {
  classifyStepActivation,
  type EdgeBearingStep,
  type PredFacts,
  type PredStatus,
} from "../services/workflow/control-flow/edge-condition.js";

/**
 * [purpose] IF control-node outcome edge evaluation. condition_true / condition_false
 *   edges activate only on an exact match against a completed IF predecessor's persisted
 *   controlOutcome; the opposite output becomes skippable; multiple downstream nodes may
 *   fan out from one output; and missing/malformed metadata activates neither branch.
 */

type Outcome = "condition_true" | "condition_false" | undefined;

function ifPred(status: PredStatus, outcome: Outcome): PredFacts {
  return { status, isQaGate: false, verdict: null, ...(outcome ? { controlOutcome: outcome } : {}) };
}

function consumer(id: string, when: "condition_true" | "condition_false"): EdgeBearingStep {
  const conditionalDependencies: ConditionalEdge[] = [{ stepId: "if-1", when }];
  return { id, conditionalDependencies };
}

describe("IF outcome edges — condition_true", () => {
  it("activates downstream when the IF completed with condition_true", () => {
    const s = consumer("on-true", "condition_true");
    expect(classifyStepActivation(s, new Map([["if-1", ifPred("completed", "condition_true")]]))).toMatchObject({ runnable: true, skippable: false });
  });
  it("becomes skippable when the IF completed with the opposite outcome (condition_false)", () => {
    const s = consumer("on-true", "condition_true");
    expect(classifyStepActivation(s, new Map([["if-1", ifPred("completed", "condition_false")]]))).toMatchObject({ runnable: false, skippable: true });
  });
});

describe("IF outcome edges — condition_false", () => {
  it("activates downstream when the IF completed with condition_false", () => {
    const s = consumer("on-false", "condition_false");
    expect(classifyStepActivation(s, new Map([["if-1", ifPred("completed", "condition_false")]]))).toMatchObject({ runnable: true, skippable: false });
  });
  it("becomes skippable when the IF completed with condition_true", () => {
    const s = consumer("on-false", "condition_false");
    expect(classifyStepActivation(s, new Map([["if-1", ifPred("completed", "condition_true")]]))).toMatchObject({ runnable: false, skippable: true });
  });
});

describe("IF outcome edges — fan out", () => {
  it("multiple downstream nodes on the same output all activate", () => {
    const preds = new Map([["if-1", ifPred("completed", "condition_true")]]);
    const a = consumer("a", "condition_true");
    const b = consumer("b", "condition_true");
    expect(classifyStepActivation(a, preds).runnable).toBe(true);
    expect(classifyStepActivation(b, preds).runnable).toBe(true);
  });
});

describe("IF outcome edges — missing/malformed metadata activates neither branch", () => {
  it("completed IF without controlOutcome activates neither true nor false branch", () => {
    const preds = new Map([["if-1", ifPred("completed", undefined)]]);
    expect(classifyStepActivation(consumer("on-true", "condition_true"), preds)).toMatchObject({ runnable: false, skippable: true });
    expect(classifyStepActivation(consumer("on-false", "condition_false"), preds)).toMatchObject({ runnable: false, skippable: true });
  });
  it("malformed controlOutcome value activates neither branch", () => {
    const preds = new Map([["if-1", { status: "completed" as PredStatus, isQaGate: false, verdict: null, controlOutcome: "bogus" as unknown as "condition_true" | "condition_false" }]]);
    expect(classifyStepActivation(consumer("on-true", "condition_true"), preds).runnable).toBe(false);
    expect(classifyStepActivation(consumer("on-false", "condition_false"), preds).runnable).toBe(false);
  });
});

describe("IF outcome edges — non-completed predecessor", () => {
  it("pending/running IF leaves downstream waiting", () => {
    for (const status of ["pending", "running"] as PredStatus[]) {
      const preds = new Map([["if-1", ifPred(status, "condition_true")]]);
      expect(classifyStepActivation(consumer("on-true", "condition_true"), preds).waiting).toBe(true);
    }
  });
  it("a failed IF does not activate the true branch (skippable, not converted to success)", () => {
    const preds = new Map([["if-1", ifPred("failed", undefined)]]);
    const act = classifyStepActivation(consumer("on-true", "condition_true"), preds);
    expect(act.runnable).toBe(false);
    expect(act.waiting).toBe(false);
  });
  it("a skipped IF does not activate either branch", () => {
    const preds = new Map([["if-1", ifPred("skipped", undefined)]]);
    expect(classifyStepActivation(consumer("on-true", "condition_true"), preds).runnable).toBe(false);
    expect(classifyStepActivation(consumer("on-false", "condition_false"), preds).runnable).toBe(false);
  });
});
