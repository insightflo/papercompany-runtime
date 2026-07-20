import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { jsonToSteps } from "../step-draft-serialization.js";
import {
  GraphInspectorControlNode,
  addWorkflowCondition,
  getWorkflowConditionAncestorOptions,
  removeWorkflowCondition,
  setWorkflowConditionCombinator,
  updateWorkflowCondition,
} from "./GraphInspectorControlNode.js";

describe("GraphInspectorControlNode helpers", () => {
  const group = jsonToSteps([{ id: "if", title: "IF", type: "if" }])[0]!.conditionGroup;

  it("switches AND/OR and adds or removes conditions", () => {
    expect(setWorkflowConditionCombinator(group, "any").combinator).toBe("any");
    const added = addWorkflowCondition(group, "producer");
    expect(added.conditions).toHaveLength(2);
    expect(removeWorkflowCondition(added, 0).conditions).toHaveLength(1);
  });

  it("clears incompatible right values when data type or unary operator changes", () => {
    const booleanGroup = updateWorkflowCondition(group, 0, { dataType: "boolean" });
    expect(booleanGroup.conditions[0]).toMatchObject({ dataType: "boolean", operator: "is_true" });
    expect(booleanGroup.conditions[0]).not.toHaveProperty("rightValue");
    const unary = updateWorkflowCondition(group, 0, { operator: "is_empty" });
    expect(unary.conditions[0]).not.toHaveProperty("rightValue");
  });

  it("offers only forward ancestor source steps", () => {
    const steps = jsonToSteps([
      { id: "root", title: "Root", type: "agent" },
      { id: "producer", title: "Producer", type: "agent", dependsOn: ["root"] },
      { id: "if", title: "IF", type: "if", dependsOn: ["producer"] },
      { id: "downstream", title: "Downstream", type: "agent", dependsOn: ["if"] },
    ]);
    expect(getWorkflowConditionAncestorOptions(steps, "if").map((step) => step.id)).toEqual(["root", "producer"]);
  });
});

describe("GraphInspectorControlNode", () => {
  it("renders an n8n-style IF builder with validation feedback", () => {
    const steps = jsonToSteps([
      { id: "producer", title: "Producer", type: "agent" },
      { id: "if", title: "IF", type: "if", dependsOn: ["producer"] },
    ]);
    const markup = renderToStaticMarkup(
      <GraphInspectorControlNode steps={steps} selectedStep={steps[1]!} updateSelected={vi.fn()} />,
    );
    expect(markup).toContain("All conditions");
    expect(markup).toContain("Any condition");
    expect(markup).toContain("Add condition");
    expect(markup).toContain("Producer");
    expect(markup).toContain("Work product title");
    expect(markup).toContain("Fix the condition fields");
  });

  it("renders Complete reason editing", () => {
    const [complete] = jsonToSteps([{ id: "done", title: "Done", type: "complete", completionReason: "No target" }]);
    const markup = renderToStaticMarkup(
      <GraphInspectorControlNode steps={[complete]} selectedStep={complete} updateSelected={vi.fn()} />,
    );
    expect(markup).toContain("Completion reason");
    expect(markup).toContain("No target");
  });
});
