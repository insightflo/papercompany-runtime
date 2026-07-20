import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJson } from "./step-draft-serialization.js";
import {
  createControlNodeStepDraft,
  defaultIfConditionGroup,
} from "./step-draft-control-nodes.js";

describe("workflow control-node drafts", () => {
  it("creates safe IF and Complete palette defaults", () => {
    const ifDraft = createControlNodeStepDraft("if", "if-1", "producer");
    const completeDraft = createControlNodeStepDraft("complete", "complete-1");

    expect(ifDraft).toMatchObject({
      id: "if-1",
      type: "if",
      dependsOn: "producer",
      conditionGroup: defaultIfConditionGroup,
      agentId: "",
      toolName: "",
    });
    expect(completeDraft).toMatchObject({
      id: "complete-1",
      type: "complete",
      dependsOn: "",
      completionReason: "",
    });
  });

  it("parses and serializes existing IF/Complete fields without dropping them", () => {
    const conditionGroup = {
      combinator: "all" as const,
      conditions: [{
        source: { kind: "work_product_json" as const, stepId: "producer", title: "decision.json", path: "$.status" },
        dataType: "string" as const,
        operator: "equals" as const,
        rightValue: "selected",
      }],
    };
    const drafts = jsonToSteps([
      { id: "producer", title: "Producer", type: "agent" },
      { id: "if-1", title: "IF", type: "if", dependsOn: ["producer"], conditionGroup },
      { id: "complete-1", title: "Complete", type: "complete", completionReason: "No target" },
    ]);

    expect(drafts[1]).toMatchObject({ type: "if", conditionGroup });
    expect(drafts[2]).toMatchObject({ type: "complete", completionReason: "No target" });
    expect(stepsToJson(drafts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "if-1", type: "if", conditionGroup }),
      expect.objectContaining({ id: "complete-1", type: "complete", completionReason: "No target" }),
    ]));
  });
});
