import { describe, expect, it } from "vitest";
import { jsonToSteps } from "./step-draft-serialization.js";
import {
  connectWorkflowSteps,
  removeWorkflowControlNodeReferences,
  renameWorkflowControlNodeReferences,
} from "./workflow-control-nodes.js";

function baseDrafts() {
  return jsonToSteps([
    { id: "producer", title: "Producer", type: "agent" },
    {
      id: "if-1",
      title: "IF",
      type: "if",
      dependsOn: ["producer"],
      conditionGroup: {
        combinator: "all",
        conditions: [{
          source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
          dataType: "string",
          operator: "equals",
          rightValue: "selected",
        }],
      },
      conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
    },
    { id: "true-target", title: "True", type: "agent" },
    { id: "false-target", title: "False", type: "complete" },
    { id: "qa", title: "QA", type: "agent" },
  ]);
}

describe("workflow control-node connections", () => {
  it("connects each fixed IF output as a conditional dependency", () => {
    let steps = baseDrafts();
    steps = connectWorkflowSteps(steps, { sourceStepId: "if-1", when: "condition_true" }, "true-target");
    steps = connectWorkflowSteps(steps, { sourceStepId: "if-1", when: "condition_false" }, "false-target");

    expect(steps.find((step) => step.id === "true-target")?.dependsOn).toBe("");
    expect(steps.find((step) => step.id === "true-target")?.extra.conditionalDependencies).toEqual([
      { stepId: "if-1", when: "condition_true" },
    ]);
    expect(steps.find((step) => step.id === "false-target")?.extra.conditionalDependencies).toEqual([
      { stepId: "if-1", when: "condition_false" },
    ]);
    expect(steps.find((step) => step.id === "if-1")?.extra.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });

  it("rejects outgoing connections from Complete", () => {
    expect(() => connectWorkflowSteps(
      baseDrafts(),
      { sourceStepId: "false-target", when: "success" },
      "true-target",
    )).toThrow(/Complete/);
  });

  it("renames and removes condition-source references safely", () => {
    const renamed = renameWorkflowControlNodeReferences(baseDrafts(), "producer", "producer-v2");
    const ifDraft = renamed.find((step) => step.id === "if-1")!;
    expect(ifDraft.dependsOn).toBe("producer-v2");
    expect(ifDraft.conditionGroup.conditions[0]?.source.stepId).toBe("producer-v2");

    const removed = removeWorkflowControlNodeReferences(renamed, "producer-v2");
    const removedIf = removed.find((step) => step.id === "if-1")!;
    expect(removedIf.dependsOn).toBe("");
    expect(removedIf.conditionGroup.conditions[0]?.source.stepId).toBe("");
  });
});
