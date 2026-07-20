import { describe, expect, it } from "vitest";
import { validateWorkflowControlNodes } from "../services/workflow/control-flow/control-node-validation.js";
import type { ConditionalEdge } from "../services/workflow/control-flow/types.js";

/**
 * [purpose] Native IF/Complete topology validation. Covers condition-group presence,
 *   fixed true/false outputs, back-edge rejection, IF-only condition predecessors,
 *   Complete's single forward IF edge + no outputs/agent/tool/loop, IF source ancestry,
 *   parallel-branch rejection, and legacy-workflow compatibility.
 */

type Step = {
  id: string;
  type?: string;
  dependencies?: string[];
  dependsOn?: string[];
  conditionalDependencies?: ConditionalEdge[];
  agentId?: string;
  agentName?: string;
  assigneeAgentId?: string;
  toolName?: string;
  tools?: string[];
  toolNames?: string[];
  conditionGroup?: { combinator?: unknown; conditions: unknown[] };
};

function ifStep(id: string, opts: Partial<Step> = {}): Step {
  const defaultSourceStepId = opts.dependencies?.[0] ?? opts.dependsOn?.[0] ?? "producer";
  return {
    id,
    type: "if",
    dependencies: opts.dependencies ?? [],
    conditionGroup: opts.conditionGroup ?? {
      combinator: "all",
      conditions: [{
        source: { kind: "work_product_json", stepId: defaultSourceStepId, title: "t.json", path: "$.x" },
        dataType: "string",
        operator: "equals",
        rightValue: "yes",
      }],
    },
    ...opts,
  };
}

function completeStep(id: string, fromIf: string, when: "condition_true" | "condition_false" = "condition_false"): Step {
  return {
    id,
    type: "complete",
    dependencies: [],
    conditionalDependencies: [{ stepId: fromIf, when }],
  };
}

function agentStep(id: string, deps: string[] = [], opts: Partial<Step> = {}): Step {
  return { id, type: "agent", dependencies: deps, agentId: opts.agentId ?? "a", ...opts };
}

function errors(steps: Step[]): string[] {
  return validateWorkflowControlNodes(steps as Parameters<typeof validateWorkflowControlNodes>[0]);
}

describe("validateWorkflowControlNodes — legacy compatibility", () => {
  it("a workflow with no control nodes is valid", () => {
    expect(errors([agentStep("a", []), agentStep("b", ["a"])])).toEqual([]);
  });
});

describe("validateWorkflowControlNodes — target topology is valid", () => {
  it("accepts the concept-radar shape (producer -> validate -> if -> true chain / false complete)", () => {
    const steps: Step[] = [
      agentStep("select", []),
      agentStep("validate", ["select"]),
      ifStep("if", { dependencies: ["validate"] }),
      agentStep("research", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      agentStep("draft", [], { dependencies: ["research"] }),
      completeStep("complete", "if", "condition_false"),
    ];
    expect(errors(steps)).toEqual([]);
  });
});

describe("validateWorkflowControlNodes — IF rules", () => {
  it("rejects an IF missing a conditionGroup", () => {
    expect(errors([ifStep("if", { conditionGroup: undefined }), completeStep("c", "if")])).toContainEqual(expect.stringContaining("conditionGroup"));
  });
  it("rejects an IF with an empty conditionGroup", () => {
    expect(errors([ifStep("if", { conditionGroup: { combinator: "all", conditions: [] } }), completeStep("c", "if")])).not.toEqual([]);
  });
  it("rejects an IF whose conditionGroup violates the shared typed contract", () => {
    const invalidGroup = {
      combinator: "all",
      conditions: [{
        source: { kind: "work_product_json", stepId: "producer", title: "t.json", path: "$.x" },
        dataType: "string",
        operator: "greater_than",
        rightValue: "yes",
      }],
    };
    const steps = [
      agentStep("producer"),
      ifStep("if", { dependencies: ["producer"], conditionGroup: invalidGroup }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("c", "if"),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("conditionGroup"));
  });
  it("rejects an IF missing the condition_true output", () => {
    const steps: Step[] = [ifStep("if", { dependencies: [] }), completeStep("c", "if", "condition_false")];
    expect(errors(steps)).toContainEqual(expect.stringContaining("condition_true"));
  });
  it("rejects an IF missing the condition_false output", () => {
    const steps: Step[] = [
      ifStep("if", { dependencies: [] }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("condition_false"));
  });
  it("rejects a condition output edge that is a back-edge", () => {
    const steps: Step[] = [
      ifStep("if", { dependencies: [] }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true", isBackEdge: true, maxIterations: 2 }] }),
      completeStep("c", "if", "condition_false"),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("back-edge"));
  });
  it("rejects a legacy success edge leaving an IF", () => {
    const steps = [
      agentStep("producer"),
      ifStep("if", { dependencies: ["producer"] }),
      agentStep("legacy-target", ["if"]),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("c", "if"),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("condition_true or condition_false"));
  });
  it("rejects failure or always conditional edges leaving an IF", () => {
    const steps = [
      agentStep("producer"),
      ifStep("if", { dependencies: ["producer"] }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("c", "if"),
      agentStep("on-always", [], { conditionalDependencies: [{ stepId: "if", when: "always" }] }),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("condition_true or condition_false"));
  });
  it("rejects agent and tool assignments on an IF", () => {
    const steps = [
      agentStep("producer"),
      ifStep("if", { dependencies: ["producer"], assigneeAgentId: "agent", tools: ["tool"] }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("c", "if"),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("IF step \"if\" must not select an agent or tool"));
  });
  it("rejects an IF source step that is not a forward ancestor", () => {
    const steps: Step[] = [
      agentStep("unrelated", []),
      ifStep("if", { dependencies: [], conditionGroup: { conditions: [{ source: { kind: "work_product_json", stepId: "unrelated", title: "t.json", path: "$.x" } }] } }),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("c", "if", "condition_false"),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("ancestor"));
  });
});

describe("validateWorkflowControlNodes — condition edge predecessor must be IF", () => {
  it("rejects a condition_true edge whose predecessor is not an IF", () => {
    const steps: Step[] = [
      agentStep("producer", []),
      agentStep("on-true", [], { conditionalDependencies: [{ stepId: "producer", when: "condition_true" }] }),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("condition_true"));
  });
});

describe("validateWorkflowControlNodes — Complete rules", () => {
  const base = (): Step[] => [
    agentStep("select", []),
    agentStep("validate", ["select"]),
    ifStep("if", { dependencies: ["validate"] }),
    agentStep("research", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
  ];
  it("rejects a Complete with zero incoming condition edges", () => {
    expect(errors([...base(), { id: "c", type: "complete", dependencies: [] }])).toContainEqual(expect.stringContaining("exactly one"));
  });
  it("rejects a Complete with two incoming condition edges", () => {
    const steps = base();
    steps.push({ id: "c", type: "complete", dependencies: [], conditionalDependencies: [
      { stepId: "if", when: "condition_false" },
      { stepId: "if", when: "condition_true" },
    ] });
    expect(errors(steps)).toContainEqual(expect.stringContaining("exactly one"));
  });
  it("rejects a Complete whose incoming edge is a legacy success dependency", () => {
    expect(errors([...base(), { id: "c", type: "complete", dependencies: ["if"] }])).toContainEqual(expect.stringContaining("condition"));
  });
  it("rejects a Complete with an outgoing edge", () => {
    const steps = base();
    steps.push(completeStep("c", "if", "condition_false"));
    steps.push(agentStep("after", [], { dependencies: ["c"] }));
    expect(errors(steps)).toContainEqual(expect.stringContaining("outgoing"));
  });
  it("rejects a Complete with an agent assignment", () => {
    const steps = base();
    steps.push({ ...completeStep("c", "if", "condition_false"), agentId: "a" });
    expect(errors(steps)).toContainEqual(expect.stringContaining("agent"));
  });
  it("rejects a Complete with a tool assignment", () => {
    const steps = base();
    steps.push({ ...completeStep("c", "if", "condition_false"), toolNames: ["t"] });
    expect(errors(steps)).toContainEqual(expect.stringContaining("tool"));
  });
  it("rejects a Complete with assigneeAgentId or tools aliases", () => {
    const steps = base();
    steps.push({ ...completeStep("c", "if", "condition_false"), assigneeAgentId: "a", tools: ["t"] });
    expect(errors(steps)).toContainEqual(expect.stringContaining("agent or tool"));
  });
  it("rejects a Complete with a loop annotation", () => {
    const steps = base();
    steps.push({ id: "c", type: "complete", dependencies: [], conditionalDependencies: [{ stepId: "if", when: "condition_false", isBackEdge: true, maxIterations: 2 }] });
    expect(errors(steps)).toContainEqual(expect.stringContaining("loop"));
  });
});

describe("validateWorkflowControlNodes — parallel-branch rejection", () => {
  it("allows independent roots that both join before the IF", () => {
    const steps: Step[] = [
      agentStep("source-a"),
      agentStep("source-b"),
      agentStep("join", ["source-a", "source-b"]),
      ifStep("if", { dependencies: ["join"] }),
      agentStep("research", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("complete", "if", "condition_false"),
    ];
    expect(errors(steps)).toEqual([]);
  });

  it("rejects a separate parallel root that would stay active when Complete is reached", () => {
    const steps: Step[] = [
      agentStep("select", []),
      agentStep("validate", ["select"]),
      ifStep("if", { dependencies: ["validate"] }),
      agentStep("research", [], { conditionalDependencies: [{ stepId: "if", when: "condition_true" }] }),
      completeStep("complete", "if", "condition_false"),
      agentStep("parallel-root", []),
      agentStep("parallel-child", ["parallel-root"]),
    ];
    expect(errors(steps)).toContainEqual(expect.stringContaining("parallel"));
  });
});
