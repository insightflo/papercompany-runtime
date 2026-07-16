import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJson } from "./step-draft.js";
import {
  resolveQaCapAcceptancePolicy,
  setQaCapAcceptance,
  setQaLoopEnabled,
  setQaReworkMaxIterations,
} from "./qa-cap-acceptance-policy.js";

/** Producer with a bounded QA rework edge and an unrelated failure edge. */
function buildStepsWithLoop() {
  return jsonToSteps([
    {
      id: "producer",
      title: "Build report",
      conditionalDependencies: [
        { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
        { stepId: "fallback", when: "failure" },
      ],
    },
    { id: "qa", title: "QA report", dependsOn: ["producer"] },
    { id: "fallback", title: "Handle failure" },
  ]);
}

/** QA step with no rework edge yet. Extra deps become real producer steps. */
function buildStepsWithoutLoop(extraDeps: string[] = []) {
  const producers = [
    { id: "producer", title: "Build report" },
    ...extraDeps.map((id) => ({ id, title: id })),
  ];
  return jsonToSteps([
    ...producers,
    { id: "qa", title: "QA report", dependsOn: ["producer", ...extraDeps] },
  ]);
}

describe("resolveQaCapAcceptancePolicy", () => {
  it("reports an enabled loop through its unique bounded rework edge", () => {
    expect(resolveQaCapAcceptancePolicy(buildStepsWithLoop(), "qa")).toEqual({
      available: true,
      enabled: true,
      allowCapAcceptance: false,
      maxIterations: 2,
      producerStepId: "producer",
    });
  });

  it("surfaces allowCapAcceptance when the edge carries the flag", () => {
    const withCap = jsonToSteps([
      {
        id: "producer",
        title: "Build report",
        conditionalDependencies: [
          { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2, allowCapAcceptance: true },
        ],
      },
      { id: "qa", title: "QA report", dependsOn: ["producer"] },
    ]);
    expect(resolveQaCapAcceptancePolicy(withCap, "qa")).toMatchObject({ enabled: true, allowCapAcceptance: true });
  });

  it("auto-selects the single upstream producer when no loop exists", () => {
    expect(resolveQaCapAcceptancePolicy(buildStepsWithoutLoop(), "qa")).toEqual({
      available: true,
      enabled: false,
      producerStepId: "producer",
      producerCandidates: ["producer"],
      requiresProducerSelection: false,
    });
  });

  it("requires explicit producer selection when multiple upstream producers exist", () => {
    const policy = resolveQaCapAcceptancePolicy(buildStepsWithoutLoop(["research"]), "qa");
    expect(policy).toEqual({
      available: true,
      enabled: false,
      producerStepId: null,
      producerCandidates: expect.arrayContaining(["producer", "research"]),
      requiresProducerSelection: true,
    });
    expect(policy.available && !policy.enabled ? policy.producerCandidates : []).toHaveLength(2);
  });

  it("explains that an upstream producer is required when none exists", () => {
    const steps = jsonToSteps([{ id: "qa", title: "QA report" }]);
    const policy = resolveQaCapAcceptancePolicy(steps, "qa");
    expect(policy).toEqual({
      available: true,
      enabled: false,
      producerStepId: null,
      producerCandidates: [],
      requiresProducerSelection: false,
    });
  });

  it("does not guess when multiple bounded QA rework edges target the step", () => {
    const ambiguous = jsonToSteps([
      {
        id: "producer-a",
        title: "A",
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      },
      {
        id: "producer-b",
        title: "B",
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      },
      { id: "qa", title: "QA", dependsOn: ["producer-a", "producer-b"] },
    ]);
    expect(resolveQaCapAcceptancePolicy(ambiguous, "qa")).toEqual({
      available: false,
      reason: "Multiple bounded QA rework edges target this step.",
    });
  });
});

describe("setQaLoopEnabled", () => {
  it("creates the qa_request_changes back-edge on the single upstream producer", () => {
    const updated = setQaLoopEnabled(buildStepsWithoutLoop(), "qa", true);
    const [producer] = stepsToJson(updated) as Array<Record<string, unknown>>;

    expect(producer.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(resolveQaCapAcceptancePolicy(updated, "qa")).toMatchObject({ enabled: true, maxIterations: 2, allowCapAcceptance: false });
  });

  it("creates the back-edge on an explicitly chosen producer when multiple upstreams exist", () => {
    const updated = setQaLoopEnabled(buildStepsWithoutLoop(["research"]), "qa", true, "research");
    const research = (stepsToJson(updated) as Array<Record<string, unknown>>).find((step) => step.id === "research");

    expect(research?.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(resolveQaCapAcceptancePolicy(updated, "qa")).toMatchObject({ enabled: true, producerStepId: "research" });
  });

  it("never guesses a producer when multiple candidates exist and none is chosen", () => {
    const steps = buildStepsWithoutLoop(["research"]);
    expect(setQaLoopEnabled(steps, "qa", true)).toBe(steps);
    expect(resolveQaCapAcceptancePolicy(steps, "qa")).toMatchObject({ enabled: false });
  });

  it("rejects an explicit producer that is not an upstream candidate", () => {
    const steps = buildStepsWithoutLoop(["research"]);
    expect(setQaLoopEnabled(steps, "qa", true, "ghost")).toBe(steps);
    expect(resolveQaCapAcceptancePolicy(steps, "qa")).toMatchObject({ enabled: false });
  });

  it("does nothing when enabling without any upstream producer", () => {
    const steps = jsonToSteps([{ id: "qa", title: "QA report" }]);
    expect(setQaLoopEnabled(steps, "qa", true)).toBe(steps);
  });

  it("does not duplicate or overwrite when a bounded edge already exists", () => {
    const withLoop = buildStepsWithLoop();
    expect(setQaLoopEnabled(withLoop, "qa", true)).toBe(withLoop);
  });

  it("removes only the qa_request_changes back-edge, preserving sibling edges", () => {
    const updated = setQaLoopEnabled(buildStepsWithLoop(), "qa", false);
    const [producer] = stepsToJson(updated) as Array<Record<string, unknown>>;

    expect(producer.conditionalDependencies).toEqual([{ stepId: "fallback", when: "failure" }]);
    expect(resolveQaCapAcceptancePolicy(updated, "qa")).toMatchObject({ enabled: false });
  });

  it("does not guess which edge to remove when multiple bounded edges exist", () => {
    const ambiguous = jsonToSteps([
      {
        id: "producer-a",
        title: "A",
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      },
      {
        id: "producer-b",
        title: "B",
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      },
      { id: "qa", title: "QA", dependsOn: ["producer-a", "producer-b"] },
    ]);
    expect(setQaLoopEnabled(ambiguous, "qa", false)).toBe(ambiguous);
  });
});

describe("setQaCapAcceptance", () => {
  it("toggles allowCapAcceptance without changing the rework count or sibling edges", () => {
    const enabled = setQaCapAcceptance(buildStepsWithLoop(), "qa", true);
    const [producer] = stepsToJson(enabled) as Array<Record<string, unknown>>;

    expect(producer.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2, allowCapAcceptance: true },
      { stepId: "fallback", when: "failure" },
    ]);

    const disabled = setQaCapAcceptance(enabled, "qa", false);
    const [producerAgain] = stepsToJson(disabled) as Array<Record<string, unknown>>;
    expect(producerAgain.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
      { stepId: "fallback", when: "failure" },
    ]);
  });

  it("is a no-op when no bounded edge exists", () => {
    const steps = buildStepsWithoutLoop();
    expect(setQaCapAcceptance(steps, "qa", true)).toBe(steps);
  });
});

describe("setQaReworkMaxIterations", () => {
  it("updates only a positive integer QA rework count", () => {
    const updated = setQaReworkMaxIterations(buildStepsWithLoop(), "qa", 4);
    expect(resolveQaCapAcceptancePolicy(updated, "qa")).toMatchObject({ maxIterations: 4 });

    expect(setQaReworkMaxIterations(updated, "qa", 0)).toBe(updated);
    expect(setQaReworkMaxIterations(updated, "qa", 1.5)).toBe(updated);
  });
});

describe("QA loop save/refresh round-trip", () => {
  it("survives stepsToJson -> jsonToSteps serialization", () => {
    const created = setQaLoopEnabled(buildStepsWithoutLoop(), "qa", true);
    const withCap = setQaCapAcceptance(created, "qa", true);
    const bumped = setQaReworkMaxIterations(withCap, "qa", 5);

    const roundTripped = jsonToSteps(stepsToJson(bumped) as Parameters<typeof jsonToSteps>[0]);
    expect(resolveQaCapAcceptancePolicy(roundTripped, "qa")).toMatchObject({
      enabled: true,
      allowCapAcceptance: true,
      maxIterations: 5,
      producerStepId: "producer",
    });
  });

  it("survives serialization after the loop is removed", () => {
    const removed = setQaLoopEnabled(buildStepsWithLoop(), "qa", false);
    const roundTripped = jsonToSteps(stepsToJson(removed) as Parameters<typeof jsonToSteps>[0]);
    expect(resolveQaCapAcceptancePolicy(roundTripped, "qa")).toMatchObject({ enabled: false });
  });
});
