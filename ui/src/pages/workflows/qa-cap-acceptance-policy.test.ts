import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJson } from "./step-draft.js";
import {
  resolveQaCapAcceptancePolicy,
  setQaCapAcceptancePolicy,
  setQaReworkMaxIterations,
} from "./qa-cap-acceptance-policy.js";

function buildSteps() {
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

describe("QA cap acceptance workflow policy", () => {
  it("resolves the selected QA through its unique bounded rework edge", () => {
    expect(resolveQaCapAcceptancePolicy(buildSteps(), "qa")).toEqual({
      available: true,
      enabled: false,
      maxIterations: 2,
      producerStepId: "producer",
    });
  });

  it("toggles acceptance without changing the retry count or sibling edges", () => {
    const updated = setQaCapAcceptancePolicy(buildSteps(), "qa", true);
    const [producer] = stepsToJson(updated) as Array<Record<string, unknown>>;

    expect(producer.conditionalDependencies).toEqual([
      {
        stepId: "qa",
        when: "qa_request_changes",
        isBackEdge: true,
        maxIterations: 2,
        allowCapAcceptance: true,
      },
      { stepId: "fallback", when: "failure" },
    ]);

    const disabled = setQaCapAcceptancePolicy(updated, "qa", false);
    expect(resolveQaCapAcceptancePolicy(disabled, "qa")).toMatchObject({ enabled: false, maxIterations: 2 });
  });

  it("updates only a positive integer QA rework count", () => {
    const updated = setQaReworkMaxIterations(buildSteps(), "qa", 4);
    expect(resolveQaCapAcceptancePolicy(updated, "qa")).toMatchObject({ maxIterations: 4 });

    expect(setQaReworkMaxIterations(updated, "qa", 0)).toBe(updated);
    expect(setQaReworkMaxIterations(updated, "qa", 1.5)).toBe(updated);
  });

  it("does not guess when the QA edge is missing or ambiguous", () => {
    const missing = buildSteps().map((step) => ({ ...step, extra: {} }));
    expect(resolveQaCapAcceptancePolicy(missing, "qa")).toEqual({
      available: false,
      reason: "No bounded QA rework edge is configured for this step.",
    });

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
      { id: "qa", title: "QA" },
    ]);
    expect(resolveQaCapAcceptancePolicy(ambiguous, "qa")).toEqual({
      available: false,
      reason: "Multiple bounded QA rework edges target this step.",
    });
  });
});
