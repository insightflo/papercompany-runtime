import { describe, expect, it } from "vitest";
import {
  buildWorkflowGraphModel,
  disconnectSteps,
  insertWorkflowStepFromPalette,
  applyStepRunsToGraphSteps,
  type WorkflowGraphStep,
} from "./workflow-graph";

describe("workflow graph helpers", () => {
  it("removes a selected edge dependency and its edge metadata", () => {
    const steps: WorkflowGraphStep[] = [
      { id: "collect", title: "Collect" },
      {
        id: "synthesize",
        title: "Synthesize",
        dependsOn: "collect, scout",
        graphEdgeMetadata: {
          collect: { kind: "conditional", label: "ready" },
          scout: { kind: "conditional", label: "fallback" },
        },
      },
    ];

    const next = disconnectSteps(steps, "collect", "synthesize");

    expect(next[1]?.dependsOn).toBe("scout");
    expect(next[1]?.graphEdgeMetadata).toEqual({ scout: { kind: "conditional", label: "fallback", condition: "" } });
  });
});

describe("native control nodes in the workflow graph", () => {
  it("renders condition_true and condition_false dependencies as labelled graph edges", () => {
    const graph = buildWorkflowGraphModel([
      { id: "if-1", title: "IF", type: "if" },
      { id: "yes", title: "Yes", conditionalDependencies: [{ stepId: "if-1", when: "condition_true" }] },
      { id: "no", title: "No", type: "complete", conditionalDependencies: [{ stepId: "if-1", when: "condition_false" }] },
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "if-1", target: "yes", when: "condition_true", label: "true" }),
      expect.objectContaining({ source: "if-1", target: "no", when: "condition_false", label: "false" }),
    ]));
  });

  it("adds IF and Complete palette templates", () => {
    const withIf = insertWorkflowStepFromPalette([], null, "if");
    const withComplete = insertWorkflowStepFromPalette(withIf, null, "complete");
    expect(withComplete).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "if", type: "if", conditionGroup: expect.any(Object) }),
      expect.objectContaining({ id: "complete", type: "complete", dependsOn: "" }),
    ]));
  });

  it("maps persisted IF outcomes into the run overlay", () => {
    const [step] = applyStepRunsToGraphSteps(
      [{ id: "if-1", title: "IF", type: "if" }] as WorkflowGraphStep[],
      [{
        id: "run-1",
        stepId: "if-1",
        status: "completed",
        metadata: { controlNodeResult: { nodeType: "if", outcome: "condition_true" } },
      }],
    );
    expect(step?.graphRunControlOutcome).toBe("condition_true");
  });
});
