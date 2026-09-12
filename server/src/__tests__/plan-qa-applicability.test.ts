import { describe, expect, it } from "vitest";
import { applicabilitySchema } from "@paperclipai/shared";
import { applies } from "../services/missions/plan-qa-applicability.js";

const T_A = "11111111-1111-4111-8111-111111111111";
const T_B = "22222222-2222-4222-8222-222222222222";
const T_C = "33333333-3333-4333-8333-333333333333";

describe("PLAN-QA addendum applicability", () => {
  it("checks only the pinned template set", () => {
    expect(applies({ op: "always" }, ["a"])).toBe(true);
    expect(applies({ op: "selected_templates_all", templateIds: ["a", "b"] }, ["a"])).toBe(false);
  });

  it("applies when every referenced template is inside the pinned selection", () => {
    expect(applies({ op: "selected_templates_all", templateIds: [T_A, T_B] }, [T_B, T_A, T_C])).toBe(true);
    expect(applies({ op: "selected_templates_all", templateIds: [T_A] }, [T_A])).toBe(true);
    expect(applies({ op: "always" }, [])).toBe(true);
  });

  it("never applies to an empty or disjoint pinned selection", () => {
    expect(applies({ op: "selected_templates_all", templateIds: [T_A] }, [])).toBe(false);
    expect(applies({ op: "selected_templates_all", templateIds: [T_A] }, [T_B, T_C])).toBe(false);
  });

  it("schema rejects empty, duplicate, malformed, and unknown-form applicability", () => {
    expect(applicabilitySchema.safeParse({ op: "always" }).success).toBe(true);
    expect(applicabilitySchema.safeParse({ op: "selected_templates_all", templateIds: [] }).success).toBe(false);
    expect(applicabilitySchema.safeParse({ op: "selected_templates_all", templateIds: [T_A, T_A] }).success).toBe(false);
    expect(applicabilitySchema.safeParse({ op: "selected_templates_all", templateIds: ["not-a-uuid"] }).success).toBe(false);
    expect(applicabilitySchema.safeParse({ op: "sometimes", templateIds: [T_A] }).success).toBe(false);
    expect(applicabilitySchema.safeParse({ op: "selected_templates_all" }).success).toBe(false);
  });
});
