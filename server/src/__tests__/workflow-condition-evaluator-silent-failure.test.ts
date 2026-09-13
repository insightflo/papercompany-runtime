/**
 * [purpose] Silent-failure verification for the two production IF-condition shapes
 *   (128-definition survey found exactly 2 work_product_json conditions):
 *   tech-blog-radar if-has-new-posts ($.noNewPosts boolean is_false) and
 *   agent-team-concept-radar if-has-selected-topic ($.status string equals "selected").
 *   Pins the fail-loud contract: a MISSING or wrong-typed left operand must throw a
 *   structured condition error — never silently evaluate to false — while a
 *   present-but-different value stays a NORMAL false branch (legitimate skip).
 * [note] The evaluator has enforced this via assertLeftType since the native IF
 *   commit; these tests pin the exact production shapes against regression.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowCondition, WorkflowConditionGroup, WorkflowConditionSource } from "@paperclipai/shared";
import { evaluateWorkflowConditionGroup } from "../services/workflow/control-flow/condition-evaluator.js";

const src = (path: string): WorkflowConditionSource => ({
  kind: "work_product_json",
  stepId: "producer",
  title: "topic-decision.json",
  path,
});

function group(conditions: WorkflowCondition[]): WorkflowConditionGroup {
  return { combinator: "all", conditions };
}

function evaluator(leftRoot: unknown) {
  return (_source: WorkflowConditionSource): unknown => leftRoot;
}

const ERR_PREFIX = "Workflow IF condition failed:";

describe("condition evaluator — silent-failure verification (production shapes)", () => {
  it("boolean is_false with a MISSING $.noNewPosts raises (never silent false)", () => {
    expect(() => evaluateWorkflowConditionGroup({
      group: group([{ source: src("$.noNewPosts"), dataType: "boolean", operator: "is_false" } as WorkflowCondition]),
      resolveSource: evaluator({ ok: true }),
    })).toThrowError(ERR_PREFIX);
  });

  it("boolean is_true with a wrong-typed $.noNewPosts raises (never silent false)", () => {
    expect(() => evaluateWorkflowConditionGroup({
      group: group([{ source: src("$.noNewPosts"), dataType: "boolean", operator: "is_true" } as WorkflowCondition]),
      resolveSource: evaluator({ noNewPosts: "false" }),
    })).toThrowError(ERR_PREFIX);
  });

  it("string equals with a MISSING $.status raises (never silent not-equal)", () => {
    expect(() => evaluateWorkflowConditionGroup({
      group: group([{ source: src("$.status"), dataType: "string", operator: "equals", rightValue: "selected" } as WorkflowCondition]),
      resolveSource: evaluator({ decided: false }),
    })).toThrowError(ERR_PREFIX);
  });

  it("string equals with a present-but-different $.status stays a NORMAL false branch", () => {
    expect(evaluateWorkflowConditionGroup({
      group: group([{ source: src("$.status"), dataType: "string", operator: "equals", rightValue: "selected" } as WorkflowCondition]),
      resolveSource: evaluator({ status: "skipped" }),
    }).outcome).toBe(false);
    expect(evaluateWorkflowConditionGroup({
      group: group([{ source: src("$.status"), dataType: "string", operator: "equals", rightValue: "selected" } as WorkflowCondition]),
      resolveSource: evaluator({ status: "selected" }),
    }).outcome).toBe(true);
  });
});
