import { describe, expect, it } from "vitest";
import { qualityEffectSchema, qualityTargetSchema } from "./quality-automation.js";

const target = {
  kind: "qa_addendum", companyId: "11111111-1111-4111-8111-111111111111",
  templateId: "22222222-2222-4222-8222-222222222222", baseHash: "ab".repeat(32),
  requirementVersionId: "req-1", inputHash: "cd".repeat(32),
  candidateVersionId: null, evaluationId: null, intentKey: "test",
  execution: { kind: "not_yet_accepted", reason: "new_improvement_execution" },
};
const candidateVersionId = "33333333-3333-4333-8333-333333333333";
const evaluationId = "44444444-4444-4444-8444-444444444444";
describe("fixed effect phase requirements", () => {
  it("keeps initial phase representable but cannot execute evaluation without fixed IDs", () => {
    expect(qualityTargetSchema.safeParse(target).success).toBe(true);
    expect(qualityEffectSchema.safeParse({ kind: "evaluate_candidate", target }).success).toBe(false);
    expect(qualityEffectSchema.safeParse({ kind: "evaluate_candidate", target: { ...target, candidateVersionId, evaluationId } }).success).toBe(true);
  });
  it("requires selection to agree with the exact target candidate and evaluation", () => {
    expect(qualityEffectSchema.safeParse({ kind: "select_candidate", candidateVersionId, target }).success).toBe(false);
    expect(qualityEffectSchema.safeParse({ kind: "select_candidate", candidateVersionId: evaluationId, target: { ...target, candidateVersionId, evaluationId } }).success).toBe(false);
    expect(qualityEffectSchema.safeParse({ kind: "select_candidate", candidateVersionId, target: { ...target, candidateVersionId, evaluationId } }).success).toBe(true);
  });
  it("does not permit output repair on an addendum target", () => {
    expect(qualityEffectSchema.safeParse({ kind: "repair_supported_output", target }).success).toBe(false);
  });
});
