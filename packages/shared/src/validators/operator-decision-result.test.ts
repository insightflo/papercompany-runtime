import { describe, expect, it } from "vitest";
import {
  cancelOperatorDecisionSchema,
  deriveOperatorDecisionResult,
  operatorDecisionResolveInputSchema,
  retryOperatorDecisionContinuationSchema,
} from "./operator-decision.js";
const definition = {
  options: [{
    id: "candidate-1",
    label: "Candidate one",
    description: null,
    facts: [{ label: "Fit", value: "Strong", status: "known" as const }],
    evidenceRefs: [{ label: "Source", href: "https://example.com/source" }],
  }],
  actions: [{
    id: "submit",
    label: "Submit",
    outcome: "submit" as const,
    tone: "primary" as const,
    requiresSelection: true,
  }],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional" as const, label: "Comment", placeholder: null, maxLength: 200 },
  approvedScope: ["Internal proposal only"],
  forbiddenScope: ["External contact"],
};
const resolveInput = {
  actionId: "submit",
  selectedOptionIds: ["candidate-1"],
  comment: " Looks good ",
};

describe("operator decision result", () => {
  it("derives outcome and normalizes selection/comment", () => {
    expect(deriveOperatorDecisionResult(definition, resolveInput)).toEqual({
      actionId: "submit",
      outcome: "submit",
      selectedOptionIds: ["candidate-1"],
      comment: "Looks good",
    });
  });

  it("stores selection in definition order", () => {
    const multi = {
      ...definition,
      options: [
        { ...definition.options[0], id: "first" },
        { ...definition.options[0], id: "second" },
      ],
      selection: { min: 1, max: 2 },
    };
    expect(deriveOperatorDecisionResult(multi, {
      ...resolveInput,
      selectedOptionIds: ["second", "first"],
    }).selectedOptionIds).toEqual(["first", "second"]);
  });

  it("rejects unknown or duplicate option IDs", () => {
    expect(() => deriveOperatorDecisionResult(definition, {
      ...resolveInput,
      selectedOptionIds: ["missing"],
    })).toThrow();
    expect(() => deriveOperatorDecisionResult(definition, {
      ...resolveInput,
      selectedOptionIds: ["candidate-1", "candidate-1"],
    })).toThrow();
  });

  it("enforces required and disabled comments", () => {
    const required = { ...definition, comment: { mode: "required" as const, label: "Why", placeholder: null, maxLength: 10 } };
    expect(() => deriveOperatorDecisionResult(required, { ...resolveInput, comment: " " })).toThrow();
    expect(() => deriveOperatorDecisionResult(required, { ...resolveInput, comment: "x".repeat(11) })).toThrow();

    const disabled = { ...definition, comment: { mode: "disabled" as const, label: null, placeholder: null, maxLength: 0 } };
    expect(deriveOperatorDecisionResult(disabled, { ...resolveInput, comment: null }).comment).toBeNull();
    expect(() => deriveOperatorDecisionResult(disabled, { ...resolveInput, comment: "not allowed" })).toThrow();
  });

  it("turns optional blank comment into null", () => {
    expect(deriveOperatorDecisionResult(definition, { ...resolveInput, comment: "  " }).comment).toBeNull();
  });

  it("allows no selection only for actions that do not require it", () => {
    const actions = {
      ...definition,
      actions: [
        definition.actions[0],
        { id: "hold", label: "Hold", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
      ],
    };
    expect(deriveOperatorDecisionResult(actions, {
      actionId: "hold",
      selectedOptionIds: [],
      comment: null,
    })).toMatchObject({ outcome: "hold", selectedOptionIds: [] });
    expect(() => deriveOperatorDecisionResult(actions, {
      actionId: "hold",
      selectedOptionIds: ["candidate-1"],
      comment: null,
    })).toThrow();
  });

  it("rejects unknown action IDs and client-supplied outcome", () => {
    expect(() => deriveOperatorDecisionResult(definition, { ...resolveInput, actionId: "missing" })).toThrow();
    expect(operatorDecisionResolveInputSchema.safeParse({ ...resolveInput, outcome: "approve" }).success).toBe(false);
  });

  it("requires exact nullable resolve keys and empty action bodies", () => {
    const { comment: _comment, ...missingComment } = resolveInput;
    expect(operatorDecisionResolveInputSchema.safeParse(missingComment).success).toBe(false);
    expect(cancelOperatorDecisionSchema.parse({})).toEqual({});
    expect(retryOperatorDecisionContinuationSchema.parse({})).toEqual({});
    expect(cancelOperatorDecisionSchema.safeParse({ reason: "no" }).success).toBe(false);
    expect(retryOperatorDecisionContinuationSchema.safeParse({ force: true }).success).toBe(false);
  });
});
