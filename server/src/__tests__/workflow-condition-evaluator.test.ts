import { describe, expect, it } from "vitest";
import type { WorkflowCondition, WorkflowConditionGroup, WorkflowConditionSource } from "@paperclipai/shared";
import {
  evaluateWorkflowConditionGroup,
  readRestrictedJsonPath,
} from "../services/workflow/control-flow/condition-evaluator.js";

/**
 * [purpose] Pure typed condition evaluator unit tests. No DB/FS. Covers every operator,
 *   strict type-mismatch-as-error, invalid date/time, NaN/infinity, missing path, null,
 *   empty containers, nested array-index paths, prototype-key rejection, and the
 *   AND/OR "evaluate-all-before-combine" invariant (a malformed 2nd condition throws
 *   even when the 1st already determines the result).
 */

const src = (path: string): WorkflowConditionSource => ({
  kind: "work_product_json",
  stepId: "producer",
  title: "topic-decision.json",
  path,
});

function cond(partial: Partial<WorkflowCondition> & { source?: WorkflowConditionSource }): WorkflowCondition {
  return {
    source: partial.source ?? src("$.status"),
    dataType: "string",
    operator: "equals",
    rightValue: "selected",
    ...partial,
  } as WorkflowCondition;
}

function group(conditions: WorkflowCondition[], combinator: "all" | "any" = "all"): WorkflowConditionGroup {
  return { combinator, conditions };
}

function evaluator(leftRoot: unknown) {
  return (source: WorkflowConditionSource): unknown => {
    // resolveSource returns the root JSON for the requested work product; the evaluator reads the path.
    expect(source.stepId).toBe("producer");
    return leftRoot;
  };
}

const ERR_PREFIX = "Workflow IF condition failed:";

describe("readRestrictedJsonPath", () => {
  it("reads root, nested object, and array-index paths", () => {
    const root = { status: "selected", topics: [{ id: 7, meta: { ok: true } }] };
    expect(readRestrictedJsonPath(root, "$")).toBe(root);
    expect(readRestrictedJsonPath(root, "$.status")).toBe("selected");
    expect(readRestrictedJsonPath(root, "$.topics[0].id")).toBe(7);
    expect(readRestrictedJsonPath(root, "$.topics[0].meta.ok")).toBe(true);
  });
  it("rejects invalid path grammar and prototype segments", () => {
    expect(() => readRestrictedJsonPath({}, "status")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({}, "$.")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({}, "$[01]")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({}, "$.__proto__")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({}, "$.constructor")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({}, "$.x.prototype")).toThrow(ERR_PREFIX);
  });
  it("rejects unsupported shapes (indexing a non-array, property of a primitive)", () => {
    expect(() => readRestrictedJsonPath({ a: "str" }, "$.a[0]")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({ a: "str" }, "$.a.b")).toThrow(ERR_PREFIX);
    expect(() => readRestrictedJsonPath({ a: [1] }, "$.a.foo")).toThrow(ERR_PREFIX);
  });
});

describe("evaluateWorkflowConditionGroup — string operators", () => {
  const root = { status: "selected", empty: "", tags: "alpha-beta" };
  it.each([
    ["equals", "selected", true],
    ["equals", "skip", false],
    ["not_equals", "skip", true],
    ["contains", "lect", true],
    ["contains", "zzz", false],
    ["not_contains", "zzz", true],
    ["starts_with", "sel", true],
    ["starts_with", "ected", false],
    ["ends_with", "ected", true],
    ["ends_with", "sel", false],
  ] as const)("%s %j -> %s", (operator, right, expected) => {
    const r = evaluateWorkflowConditionGroup({
      group: group([cond({ source: src("$.status"), operator, rightValue: right })]),
      resolveSource: evaluator(root),
    });
    expect(r.outcome).toBe(expected);
    expect(r.results).toEqual([expected]);
  });
  it("is_empty / is_not_empty on an empty vs non-empty string", () => {
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.empty"), operator: "is_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.empty"), operator: "is_not_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(false);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.status"), operator: "is_not_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
  });
});

describe("evaluateWorkflowConditionGroup — number operators", () => {
  const root = { count: 5 };
  it.each([
    ["equals", 5, true],
    ["equals", 6, false],
    ["not_equals", 6, true],
    ["greater_than", 4, true],
    ["greater_than", 5, false],
    ["greater_than_or_equal", 5, true],
    ["less_than", 6, true],
    ["less_than_or_equal", 5, true],
    ["less_than", 5, false],
  ] as const)("%s %j -> %s", (operator, right, expected) => {
    expect(
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.count"), dataType: "number", operator, rightValue: right })]),
        resolveSource: evaluator(root),
      }).outcome,
    ).toBe(expected);
  });
});

describe("evaluateWorkflowConditionGroup — boolean operators", () => {
  it("is_true / is_false read the boolean strictly", () => {
    const root = { ready: true, armed: false };
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.ready"), dataType: "boolean", operator: "is_true" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.armed"), dataType: "boolean", operator: "is_false" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.ready"), dataType: "boolean", operator: "is_false" })]), resolveSource: evaluator(root) }).outcome).toBe(false);
  });
});

describe("evaluateWorkflowConditionGroup — date_time operators", () => {
  const root = { at: "2026-07-20T10:00:00.000Z" };
  it.each([
    ["equals", "2026-07-20T10:00:00.000Z", true],
    ["equals", "2026-07-20T11:00:00.000Z", false],
    ["after", "2026-07-20T09:00:00.000Z", true],
    ["after_or_equal", "2026-07-20T10:00:00.000Z", true],
    ["before", "2026-07-20T11:00:00.000Z", true],
    ["before_or_equal", "2026-07-20T10:00:00.000Z", true],
    ["not_equals", "2026-07-20T11:00:00.000Z", true],
  ] as const)("%s %j -> %s", (operator, right, expected) => {
    expect(
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.at"), dataType: "date_time", operator, rightValue: right })]),
        resolveSource: evaluator(root),
      }).outcome,
    ).toBe(expected);
  });
  it("compares offset and Z date/time values by epoch instant", () => {
    // 2026-07-20T10:00:00+09:00 == 2026-07-20T01:00:00Z (same instant)
    const root = { at: "2026-07-20T10:00:00+09:00" };
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.at"), dataType: "date_time", operator: "equals", rightValue: "2026-07-20T01:00:00Z" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.at"), dataType: "date_time", operator: "after", rightValue: "2026-07-20T01:00:01Z" })]), resolveSource: evaluator(root) }).outcome).toBe(false);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.at"), dataType: "date_time", operator: "before", rightValue: "2026-07-20T01:00:00Z" })]), resolveSource: evaluator(root) }).outcome).toBe(false);
  });
});

describe("evaluateWorkflowConditionGroup — array / object operators", () => {
  const root = { list: [1, 2, 3], emptyList: [], obj: { a: 1 }, emptyObj: {} };
  it("array is_empty/is_not_empty/contains", () => {
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.list"), dataType: "array", operator: "is_not_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.emptyList"), dataType: "array", operator: "is_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.list"), dataType: "array", operator: "contains", rightValue: 2 })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.list"), dataType: "array", operator: "contains", rightValue: 9 })]), resolveSource: evaluator(root) }).outcome).toBe(false);
  });
  it("object is_empty/is_not_empty/has_key", () => {
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.obj"), dataType: "object", operator: "is_not_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.emptyObj"), dataType: "object", operator: "is_empty" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.obj"), dataType: "object", operator: "has_key", rightValue: "a" })]), resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([cond({ source: src("$.obj"), dataType: "object", operator: "has_key", rightValue: "b" })]), resolveSource: evaluator(root) }).outcome).toBe(false);
  });
});

describe("evaluateWorkflowConditionGroup — fail-closed (errors, never false)", () => {
  it("type mismatch raises instead of returning false", () => {
    expect(() =>
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.status"), dataType: "number", operator: "equals", rightValue: 5 })]),
        resolveSource: evaluator({ status: "selected" }),
      }),
    ).toThrowError(ERR_PREFIX);
  });
  it("missing path raises (undefined value is a type mismatch)", () => {
    expect(() =>
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.missing"), operator: "is_empty" })]),
        resolveSource: evaluator({ status: "selected" }),
      }),
    ).toThrowError(ERR_PREFIX);
  });
  it("null value raises for a string condition", () => {
    expect(() =>
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.status"), operator: "equals", rightValue: "x" })]),
        resolveSource: evaluator({ status: null }),
      }),
    ).toThrowError(ERR_PREFIX);
  });
  it("invalid date_time left value raises", () => {
    expect(() =>
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.at"), dataType: "date_time", operator: "after", rightValue: "2026-07-20T00:00:00.000Z" })]),
        resolveSource: evaluator({ at: "not-a-date" }),
      }),
    ).toThrowError(ERR_PREFIX);
  });
  it("parseable but non-ISO date_time left value (e.g. 07/20/2026) raises", () => {
    expect(() =>
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.at"), dataType: "date_time", operator: "after", rightValue: "2026-07-20T00:00:00.000Z" })]),
        resolveSource: evaluator({ at: "07/20/2026" }),
      }),
    ).toThrowError(ERR_PREFIX);
  });
  it("NaN / Infinity left values raise for number", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        evaluateWorkflowConditionGroup({
          group: group([cond({ source: src("$.n"), dataType: "number", operator: "equals", rightValue: 1 })]),
          resolveSource: evaluator({ n: bad }),
        }),
      ).toThrowError(ERR_PREFIX);
    }
  });
  it("error messages do not leak raw work-product content", () => {
    let message = "";
    try {
      evaluateWorkflowConditionGroup({
        group: group([cond({ source: src("$.secret"), dataType: "number", operator: "equals", rightValue: 1 })]),
        resolveSource: evaluator({ secret: "SUPER-SECRET-TOKEN" }),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith(ERR_PREFIX)).toBe(true);
    expect(message).not.toContain("SUPER-SECRET-TOKEN");
    expect(message).toContain("$.secret");
  });
});

describe("evaluateWorkflowConditionGroup — combinator and no-short-circuit invariant", () => {
  const root = { a: "x", b: 5 };
  it("all(AND) requires every condition true", () => {
    const g = group([
      cond({ source: src("$.a"), operator: "equals", rightValue: "x" }),
      cond({ source: src("$.b"), dataType: "number", operator: "greater_than", rightValue: 1 }),
    ], "all");
    expect(evaluateWorkflowConditionGroup({ group: g, resolveSource: evaluator(root) }).outcome).toBe(true);
    expect(evaluateWorkflowConditionGroup({ group: group([g.conditions[0]!, cond({ source: src("$.b"), dataType: "number", operator: "greater_than", rightValue: 99 })], "all"), resolveSource: evaluator(root) }).outcome).toBe(false);
  });
  it("any(OR) is true when at least one condition holds", () => {
    const g = group([
      cond({ source: src("$.a"), operator: "equals", rightValue: "nope" }),
      cond({ source: src("$.b"), dataType: "number", operator: "greater_than", rightValue: 1 }),
    ], "any");
    expect(evaluateWorkflowConditionGroup({ group: g, resolveSource: evaluator(root) }).outcome).toBe(true);
  });
  it("a malformed second condition throws even when the first already determines the AND result", () => {
    // first condition is false → AND is already false, but the second (type mismatch) must still throw.
    const g = group([
      cond({ source: src("$.a"), operator: "equals", rightValue: "nope" }),
      cond({ source: src("$.b"), dataType: "string", operator: "equals", rightValue: "wrong-type" }),
    ], "all");
    expect(() => evaluateWorkflowConditionGroup({ group: g, resolveSource: evaluator(root) })).toThrowError(ERR_PREFIX);
  });
  it("a malformed second condition throws even when the first already determines the OR result", () => {
    const g = group([
      cond({ source: src("$.a"), operator: "equals", rightValue: "x" }),
      cond({ source: src("$.b"), dataType: "string", operator: "equals", rightValue: "wrong-type" }),
    ], "any");
    expect(() => evaluateWorkflowConditionGroup({ group: g, resolveSource: evaluator(root) })).toThrowError(ERR_PREFIX);
  });
});
