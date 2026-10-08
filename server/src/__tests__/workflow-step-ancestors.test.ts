import { describe, expect, it } from "vitest";
import { collectAncestorStepIds, collectArtifactReferences, findWorkflowToolReferenceErrors } from "../services/workflow/step-artifact-references.js";
import type { ConditionalEdgeWhen } from "../services/workflow/control-flow/types.js";

const branch = (id: string, stepId: string, when: ConditionalEdgeWhen) => ({
  id, dependsOn: [], conditionalDependencies: [{ stepId, when }],
});

describe("step artifact structural ancestors", () => {
  it("reports unknown, sibling and self references once per step", () => {
    const steps = [{ id: "source" }, { id: "if", dependencies: ["source"] },
      branch("false", "if", "condition_false"), { ...branch("publish", "if", "condition_true"), toolArgs: {
        good: "{$steps.source.workProductPath}", bad: ["{$steps.missing.workProductDir}",
          "{$steps.false.siblingAssetsDir}", "{$steps.publish.workProductPath}", "{$steps.missing.workProductPath}"],
      } }];
    expect(findWorkflowToolReferenceErrors(steps)).toEqual([
      { stepId: "publish", referencedStepId: "missing", reason: "unknown_step" },
      { stepId: "publish", referencedStepId: "false", reason: "not_ancestor" },
      { stepId: "publish", referencedStepId: "publish", reason: "not_ancestor" },
    ]);
  });
  it.each(["condition_true", "condition_false"] as const)("follows the %s IF branch, not its sibling", when => {
    const steps = [
      { id: "producer", dependsOn: [] }, { id: "if", dependsOn: ["producer"] },
      branch("consumer", "if", when), branch("sibling", "if", when === "condition_true" ? "condition_false" : "condition_true"),
    ];
    expect([...collectAncestorStepIds("consumer", steps)].sort()).toEqual(["if", "producer"]);
  });

  it("walks nested IFs and ordinary dependencies", () => {
    const steps = [
      { id: "producer" }, { id: "outer-if", dependencies: ["producer"] },
      branch("first", "outer-if", "condition_true"),
      { id: "inner-if", dependencies: ["first"] }, branch("consumer", "inner-if", "condition_false"),
    ];
    expect([...collectAncestorStepIds("consumer", steps)].sort()).toEqual(["first", "inner-if", "outer-if", "producer"]);
  });

  it("supports concept-radar publish referencing select-novel-concept above the IF", () => {
    const steps = [
      { id: "select-novel-concept" }, { id: "validate-selection", dependsOn: ["select-novel-concept"] },
      { id: "if-has-selected-topic", dependsOn: ["validate-selection"] },
      branch("research", "if-has-selected-topic", "condition_true"),
      { id: "publish", dependencies: ["research"] }, branch("complete", "if-has-selected-topic", "condition_false"),
    ];
    expect([...collectAncestorStepIds("publish", steps)].sort()).toEqual([
      "if-has-selected-topic", "research", "select-novel-concept", "validate-selection",
    ]);
  });

  it.each(["success", "failure", "always", "qa_request_changes", undefined] as const)("follows forward %s links", when => {
    expect([...collectAncestorStepIds("consumer", [
      { id: "producer" }, { id: "consumer", conditionalDependencies: [{ stepId: "producer", when }] },
    ])]).toEqual(["producer"]);
  });

  it.each(["condition_true", "condition_false", "qa_request_changes", "always"] as const)("excludes %s back edges and their later ancestors", when => {
    const steps = [
      { id: "producer", conditionalDependencies: [{ stepId: "qa", when, isBackEdge: true }] },
      { id: "consumer", dependencies: ["producer"] }, { id: "qa", dependencies: ["consumer"] },
    ];
    expect([...collectAncestorStepIds("consumer", steps)]).toEqual(["producer"]);
  });

  it("excludes self even on malformed cycles and respects canonical dependencies", () => {
    expect([...collectAncestorStepIds("a", [
      { id: "a", dependencies: ["b"], dependsOn: ["ignored"] }, { id: "b", dependencies: ["a"] },
    ])]).toEqual(["b"]);
  });

  it("scans only the renderer's exact artifact tokens recursively and deduplicates step IDs", () => {
    expect([...collectArtifactReferences({ nested: [
      "{$steps.a.workProductPath} {$steps.a.workProductDir}", { asset: "{$steps.b-c.siblingAssetsDir}" },
      "{$steps.x.status}", "Agent says step y is done",
    ] })]).toEqual(["a", "b-c"]);
  });
});
