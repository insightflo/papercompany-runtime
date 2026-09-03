import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_IF_JSON_PATH_PATTERN,
  WORKFLOW_IF_MAX_CONDITIONS,
  workflowConditionGroupSchema,
  workflowConditionSchema,
  workflowConditionSourceSchema,
  workflowControlNodeResultSchema,
  workflowIfControlResultSchema,
  type WorkflowConditionOperator,
} from "./workflow-condition.js";
import { workflowStepDefinitionSchema } from "./workflow.js";

/**
 * [purpose] Strict typed n8n-like IF/Complete control-node contract tests.
 *   Covers source shape, data-type/operator compatibility, unary rightValue rule,
 *   JSON-path restriction, combinator bounds, control-node result persistence shape,
 *   and the workflowStepDefinitionSchema IF/Complete refine rules.
 */

const validSource = {
  kind: "work_product_json" as const,
  stepId: "select-novel-concept",
  title: "topic-decision.json",
  path: "$.status",
};

describe("workflowConditionSourceSchema", () => {
  it("accepts a canonical work_product_json source", () => {
    expect(workflowConditionSourceSchema.parse(validSource)).toEqual(validSource);
  });
  it("rejects an unknown source kind (non work_product_json)", () => {
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validSource, kind: "run_metadata" }),
    ).toThrow();
  });
  it("rejects an empty path and an invalid JSON path", () => {
    expect(() => workflowConditionSourceSchema.parse({ ...validSource, path: "" })).toThrow();
    expect(() => workflowConditionSourceSchema.parse({ ...validSource, path: "status" })).toThrow();
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validSource, path: "$.__proto__" }),
    ).toThrow();
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validSource, path: "$.a.-1" }),
    ).toThrow();
  });
  it("accepts nested object and array-index paths", () => {
    expect(
      workflowConditionSourceSchema.parse({ ...validSource, path: "$.topics[0].id" }).path,
    ).toBe("$.topics[0].id");
  });
  it("rejects unknown extra source keys", () => {
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validSource, extra: 1 }),
    ).toThrow();
  });
});

describe("workflowConditionSchema — data type / operator compatibility", () => {
  it("accepts a valid string equals condition with a string right value", () => {
    const cond = {
      source: validSource,
      dataType: "string" as const,
      operator: "equals",
      rightValue: "selected",
    };
    expect(workflowConditionSchema.parse(cond)).toMatchObject({
      dataType: "string",
      operator: "equals",
      rightValue: "selected",
    });
  });
  it("rejects an unsupported operator for the declared data type", () => {
    expect(() =>
      workflowConditionSchema.parse({
        source: validSource,
        dataType: "boolean",
        operator: "contains",
      }),
    ).toThrow();
  });
  it.each([
    ["number", "greater_than", 5],
    ["date_time", "after", "2026-07-20T00:00:00Z"],
    ["date_time", "after", "2026-07-20T10:00:00+09:00"],
    ["array", "contains", "needle"],
    ["array", "contains", 7],
    ["object", "has_key", "title"],
  ] as const)("accepts %s %s with a compatible right value", (dataType, operator, rightValue) => {
    expect(() =>
      workflowConditionSchema.parse({ source: validSource, dataType, operator, rightValue }),
    ).not.toThrow();
  });
  it.each([
    ["number", "greater_than", "5"],
    ["number", "greater_than", NaN],
    ["number", "greater_than", Infinity],
    ["date_time", "after", "not-a-date"],
    ["date_time", "after", "07/20/2026"],
    ["object", "has_key", 5],
    ["object", "has_key", ""],
    ["array", "contains", {}],
    ["array", "contains", NaN],
    ["array", "contains", Infinity],
  ] as const)("rejects %s %s with an incompatible right value %j", (dataType, operator, rightValue) => {
    expect(() =>
      workflowConditionSchema.parse({ source: validSource, dataType, operator, rightValue }),
    ).toThrow();
  });
});

describe("workflowConditionSchema — unary operators reject rightValue", () => {
  it.each([
    ["string", "is_empty"],
    ["string", "is_not_empty"],
    ["boolean", "is_true"],
    ["boolean", "is_false"],
    ["array", "is_empty"],
    ["object", "is_not_empty"],
  ] as const)("%s %s must not include a right value", (dataType, operator) => {
    expect(() =>
      workflowConditionSchema.parse({ source: validSource, dataType, operator }),
    ).not.toThrow();
    expect(() =>
      workflowConditionSchema.parse({ source: validSource, dataType, operator, rightValue: "x" }),
    ).toThrow();
  });
  it("rejects a binary operator missing its right value", () => {
    expect(() =>
      workflowConditionSchema.parse({ source: validSource, dataType: "string", operator: "equals" }),
    ).toThrow();
  });
});

describe("workflowConditionGroupSchema", () => {
  it("accepts a single-condition all group", () => {
    const group = {
      combinator: "all" as const,
      conditions: [
        { source: validSource, dataType: "string", operator: "equals", rightValue: "selected" },
      ],
    };
    expect(workflowConditionGroupSchema.parse(group).combinator).toBe("all");
  });
  it("accepts an any combinator with multiple conditions", () => {
    const group = {
      combinator: "any" as const,
      conditions: [
        { source: validSource, dataType: "string", operator: "equals", rightValue: "a" },
        { source: validSource, dataType: "string", operator: "equals", rightValue: "b" },
      ],
    };
    expect(workflowConditionGroupSchema.parse(group).conditions).toHaveLength(2);
  });
  it("rejects an empty condition group", () => {
    expect(() => workflowConditionGroupSchema.parse({ combinator: "all", conditions: [] })).toThrow();
  });
  it("rejects an unknown combinator", () => {
    expect(() =>
      workflowConditionGroupSchema.parse({
        combinator: "xor",
        conditions: [
          { source: validSource, dataType: "string", operator: "equals", rightValue: "x" },
        ],
      }),
    ).toThrow();
  });
  it("rejects more than the configured maximum conditions", () => {
    const conditions = Array.from({ length: WORKFLOW_IF_MAX_CONDITIONS + 1 }, () => ({
      source: validSource,
      dataType: "string" as const,
      operator: "equals" as const,
      rightValue: "x",
    }));
    expect(() =>
      workflowConditionGroupSchema.parse({ combinator: "all", conditions }),
    ).toThrow();
  });
});

describe("workflowControlNodeResultSchema", () => {
  it("accepts an IF control result for either outcome", () => {
    const base = {
      nodeType: "if" as const,
      outcome: "condition_true" as const,
      evaluatedAt: "2026-07-20T10:00:00.000Z",
      conditionCount: 1,
      combinator: "all" as const,
      sourceSummary: [{ stepId: "select-novel-concept", title: "topic-decision.json", path: "$.status" }],
    };
    expect(workflowControlNodeResultSchema.parse(base)).toMatchObject({ outcome: "condition_true" });
    expect(() =>
      workflowControlNodeResultSchema.parse({ ...base, outcome: "condition_false" }),
    ).not.toThrow();
  });
  it("rejects an IF result with an unknown outcome", () => {
    expect(() =>
      workflowControlNodeResultSchema.parse({
        nodeType: "if",
        outcome: "maybe",
        evaluatedAt: "2026-07-20T10:00:00.000Z",
        conditionCount: 1,
        combinator: "all",
        sourceSummary: [{ stepId: "select-novel-concept", title: "topic-decision.json", path: "$.status" }],
      }),
    ).toThrow();
  });
  it("rejects an IF result with conditionCount below 1 or above the cap", () => {
    const valid = {
      nodeType: "if" as const,
      outcome: "condition_true" as const,
      evaluatedAt: "2026-07-20T10:00:00.000Z",
      conditionCount: 1,
      combinator: "all" as const,
      sourceSummary: [{ stepId: "s", title: "t.json", path: "$.x" }],
    };
    expect(() => workflowControlNodeResultSchema.parse({ ...valid, conditionCount: 0 })).toThrow();
    expect(() => workflowControlNodeResultSchema.parse({ ...valid, conditionCount: WORKFLOW_IF_MAX_CONDITIONS + 1 })).toThrow();
  });
  it("rejects an IF result with an empty sourceSummary", () => {
    expect(() =>
      workflowControlNodeResultSchema.parse({
        nodeType: "if",
        outcome: "condition_true",
        evaluatedAt: "2026-07-20T10:00:00.000Z",
        conditionCount: 1,
        combinator: "all",
        sourceSummary: [],
      }),
    ).toThrow();
  });
  it("accepts a Complete control result with an optional reason", () => {
    const base = {
      nodeType: "complete" as const,
      outcome: "completed" as const,
      completedAt: "2026-07-20T10:00:00.000Z",
    };
    expect(workflowControlNodeResultSchema.parse(base).outcome).toBe("completed");
    const withReason = workflowControlNodeResultSchema.parse({ ...base, reason: "no novel topic" });
    expect(withReason.nodeType).toBe("complete");
    if (withReason.nodeType === "complete") {
      expect(withReason.reason).toBe("no novel topic");
    }
  });
  it("rejects a Complete reason that is empty, whitespace-only, or too long", () => {
    const base = {
      nodeType: "complete" as const,
      outcome: "completed" as const,
      completedAt: "2026-07-20T10:00:00.000Z",
    };
    expect(() => workflowControlNodeResultSchema.parse({ ...base, reason: "   " })).toThrow();
    expect(() => workflowControlNodeResultSchema.parse({ ...base, reason: "" })).toThrow();
    expect(() => workflowControlNodeResultSchema.parse({ ...base, reason: "x".repeat(501) })).toThrow();
    // trimmed boundary is accepted
    expect(() => workflowControlNodeResultSchema.parse({ ...base, reason: "x".repeat(500) })).not.toThrow();
  });
});

describe("workflowStepDefinitionSchema — control node refine rules", () => {
  it("accepts a valid IF step", () => {
    const step = {
      id: "if-has-selected-topic",
      title: "Has a selected topic?",
      type: "if",
      dependencies: ["validate-novelty-decision"],
      conditionGroup: {
        combinator: "all",
        conditions: [
          { source: validSource, dataType: "string", operator: "equals", rightValue: "selected" },
        ],
      },
    };
    expect(workflowStepDefinitionSchema.parse(step).type).toBe("if");
  });
  it("accepts a valid Complete step", () => {
    const step = {
      id: "complete-no-novel-topic",
      title: "No novel topic today",
      type: "complete",
      conditionalDependencies: [{ stepId: "if-has-selected-topic", when: "condition_false" }],
      completionReason: "No qualifying novel topic was selected.",
    };
    expect(workflowStepDefinitionSchema.parse(step).type).toBe("complete");
  });
  it("rejects an IF step missing conditionGroup", () => {
    expect(() =>
      workflowStepDefinitionSchema.parse({ id: "if-1", type: "if", dependencies: [] }),
    ).toThrow();
  });
  it("rejects conditionGroup on a non-IF step", () => {
    expect(() =>
      workflowStepDefinitionSchema.parse({
        id: "agent-1",
        type: "agent",
        conditionGroup: {
          combinator: "all",
          conditions: [
            { source: validSource, dataType: "string", operator: "equals", rightValue: "x" },
          ],
        },
      }),
    ).toThrow();
  });
  it("rejects completionReason on a non-Complete step", () => {
    expect(() =>
      workflowStepDefinitionSchema.parse({
        id: "agent-1",
        type: "agent",
        completionReason: "done",
      }),
    ).toThrow();
  });
  it("preserves unknown legacy step fields via passthrough", () => {
    const parsed = workflowStepDefinitionSchema.parse({
      id: "legacy-1",
      type: "custom-future",
      magicField: 42,
    });
    expect((parsed as { magicField?: number }).magicField).toBe(42);
  });
});

describe("exports surface", () => {
  it("exposes the operator families, path pattern, and condition cap", () => {
    expect(WORKFLOW_CONDITION_OPERATORS.string).toContain("equals");
    expect(WORKFLOW_CONDITION_OPERATORS.boolean).toEqual(["is_true", "is_false"]);
    expect(WORKFLOW_IF_JSON_PATH_PATTERN.test("$.status")).toBe(true);
    expect(WORKFLOW_IF_MAX_CONDITIONS).toBeGreaterThan(0);
  });
  it("preserves a literal WorkflowConditionOperator union on parsed conditions", () => {
    const parsed = workflowConditionSchema.parse({
      source: validSource,
      dataType: "string",
      operator: "equals",
      rightValue: "selected",
    });
    // Compile-time guard: if operator widened to `string`, this assignment errors.
    const operatorLiteral: WorkflowConditionOperator = parsed.operator;
    expect(["equals", "not_equals"]).toContain(operatorLiteral);
    expect(parsed.operator).toBe("equals");
  });
});

describe("workflowConditionSourceSchema — tool_json", () => {
  const validToolSource = {
    kind: "tool_json" as const,
    stepId: "flow-clips",
    toolName: "shorts-storage-list",
    parameters: { action: "list", prefix: "shorts/runs/r1/clips/" },
    path: "$.count",
  };

  it("accepts a canonical tool_json source", () => {
    expect(workflowConditionSourceSchema.parse(validToolSource)).toEqual(validToolSource);
  });

  it("defaults parameters to an empty object", () => {
    const parsed = workflowConditionSourceSchema.parse({
      kind: "tool_json",
      stepId: "s",
      toolName: "t",
      path: "$.count",
    });
    expect(parsed.kind).toBe("tool_json");
    if (parsed.kind === "tool_json") expect(parsed.parameters).toEqual({});
  });

  it("rejects a tool_json source with a prototype JSON path", () => {
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validToolSource, path: "$.constructor" }),
    ).toThrow();
  });

  it("rejects an empty toolName", () => {
    expect(() => workflowConditionSourceSchema.parse({ ...validToolSource, toolName: "  " })).toThrow();
  });

  it("rejects a tool_json source with non-object parameters", () => {
    expect(() =>
      workflowConditionSourceSchema.parse({ ...validToolSource, parameters: [1, 2] }),
    ).toThrow();
  });
});

describe("workflowConditionSourceSummarySchema — persisted IF result summaries", () => {
  const baseResult = {
    nodeType: "if",
    outcome: "condition_true",
    evaluatedAt: "2026-09-05T00:00:00.000Z",
    conditionCount: 1,
    combinator: "all",
  };

  it("parses a legacy source summary without kind (title only)", () => {
    const parsed = workflowIfControlResultSchema.parse({
      ...baseResult,
      sourceSummary: [{ stepId: "p", title: "decision.json", path: "$.status" }],
    });
    expect(parsed.sourceSummary[0]?.title).toBe("decision.json");
  });

  it("parses a tool source summary with kind and toolName", () => {
    const parsed = workflowIfControlResultSchema.parse({
      ...baseResult,
      sourceSummary: [{ kind: "tool_json", stepId: "p", toolName: "shorts-storage-list", path: "$.count" }],
    });
    expect(parsed.sourceSummary[0]?.toolName).toBe("shorts-storage-list");
  });

  it("rejects a summary with both title and toolName", () => {
    expect(() =>
      workflowIfControlResultSchema.parse({
        ...baseResult,
        sourceSummary: [{ stepId: "p", title: "t", toolName: "x", path: "$.a" }],
      }),
    ).toThrow();
  });

  it("rejects a summary with neither title nor toolName", () => {
    expect(() =>
      workflowIfControlResultSchema.parse({
        ...baseResult,
        sourceSummary: [{ stepId: "p", path: "$.a" }],
      }),
    ).toThrow();
  });
});
