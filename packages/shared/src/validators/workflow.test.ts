import { describe, it, expect } from "vitest";
import { workflowStepDefinitionSchema } from "./workflow.js";

describe("workflowStepDefinitionSchema retry fields", () => {
  it("accepts valid fixed backoff with delay and jitter", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      onFailure: "retry",
      maxRetries: 3,
      graphRetryDelaySeconds: 5,
      graphRetryBackoff: "fixed",
      graphRetryJitter: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts linear and exponential backoff", () => {
    for (const backoff of ["linear", "exponential"] as const) {
      const result = workflowStepDefinitionSchema.safeParse({
        id: "step-1",
        graphRetryBackoff: backoff,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts delay zero", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted retry fields (backward compat)", () => {
    const result = workflowStepDefinitionSchema.safeParse({ id: "step-1" });
    expect(result.success).toBe(true);
  });

  it("rejects negative delay", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional delay", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryDelaySeconds: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown backoff", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryBackoff: "aggressive",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean jitter", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      graphRetryJitter: "yes" as unknown as boolean,
    });
    expect(result.success).toBe(false);
  });

  it("keeps maxRetries non-negative with no upper bound", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "step-1",
      maxRetries: 9999,
    });
    expect(result.success).toBe(true);
  });
});
