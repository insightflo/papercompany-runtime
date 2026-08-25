import { describe, expect, it } from "vitest";
import {
  workflowQaRemediationsSchema,
  workflowStringReplaceRemediationSchema,
  workflowVerdictSubmitSchema,
  WORKFLOW_REMEDIATION_FIND_MAX_LENGTH,
  WORKFLOW_REMEDIATION_MAX_ITEMS,
  WORKFLOW_REMEDIATION_REPLACE_MAX_LENGTH,
} from "./workflow-agent-api.js";

const validItem = {
  op: "string_replace",
  file: "/srv/papercompany/out/issue-1/index.html",
  find: "internal-only term: leads/evidence.json",
  replace: "선별 기준 요약",
};

describe("workflowStringReplaceRemediationSchema", () => {
  it("accepts a well-formed string_replace item", () => {
    const parsed = workflowStringReplaceRemediationSchema.safeParse(validItem);
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty replace (pure deletion)", () => {
    const parsed = workflowStringReplaceRemediationSchema.safeParse({ ...validItem, replace: "" });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown op values", () => {
    const parsed = workflowStringReplaceRemediationSchema.safeParse({ ...validItem, op: "regex_replace" });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty/oversized find and oversized replace", () => {
    expect(workflowStringReplaceRemediationSchema.safeParse({ ...validItem, find: "" }).success).toBe(false);
    expect(
      workflowStringReplaceRemediationSchema.safeParse({ ...validItem, find: "x".repeat(WORKFLOW_REMEDIATION_FIND_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      workflowStringReplaceRemediationSchema.safeParse({ ...validItem, replace: "y".repeat(WORKFLOW_REMEDIATION_REPLACE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict contract)", () => {
    const parsed = workflowStringReplaceRemediationSchema.safeParse({ ...validItem, note: "human prose" });
    expect(parsed.success).toBe(false);
  });
});

describe("workflowQaRemediationsSchema", () => {
  it("accepts 1..max bounded items", () => {
    expect(workflowQaRemediationsSchema.safeParse({ items: [validItem] }).success).toBe(true);
    const items = Array.from({ length: WORKFLOW_REMEDIATION_MAX_ITEMS }, () => ({ ...validItem }));
    expect(workflowQaRemediationsSchema.safeParse({ items }).success).toBe(true);
  });

  it("rejects empty and oversized item arrays", () => {
    expect(workflowQaRemediationsSchema.safeParse({ items: [] }).success).toBe(false);
    const items = Array.from({ length: WORKFLOW_REMEDIATION_MAX_ITEMS + 1 }, () => ({ ...validItem }));
    expect(workflowQaRemediationsSchema.safeParse({ items }).success).toBe(false);
  });
});

describe("workflowVerdictSubmitSchema remediations", () => {
  it("accepts remediations only together with verdict=request_changes", () => {
    const ok = workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      reason: "mechanical term exposure",
      remediations: { items: [validItem] },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects remediations with verdict=pass", () => {
    const parsed = workflowVerdictSubmitSchema.safeParse({
      verdict: "pass",
      remediations: { items: [validItem] },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps accepting the legacy body without remediations", () => {
    expect(workflowVerdictSubmitSchema.safeParse({ verdict: "pass" }).success).toBe(true);
    expect(workflowVerdictSubmitSchema.safeParse({ verdict: "request_changes", reason: "x" }).success).toBe(true);
  });
});
