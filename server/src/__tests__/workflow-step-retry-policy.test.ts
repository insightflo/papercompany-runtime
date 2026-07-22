import { describe, it, expect } from "vitest";
import {
  normalizeWorkflowRetryPolicy,
  calculateWorkflowRetryDelaySeconds,
  classifyWorkflowStepRetry,
  type WorkflowRetryPolicy,
} from "../services/workflow/retry-policy.js";

function policy(overrides: Partial<WorkflowRetryPolicy> = {}): WorkflowRetryPolicy {
  return {
    enabled: true,
    maxRetries: 2,
    delaySeconds: 0,
    backoff: "fixed",
    jitter: false,
    ...overrides,
  };
}

function classificationInput(overrides: Record<string, unknown> = {}) {
  return {
    policy: policy(),
    stepRunStatus: "failed",
    retryCount: 0,
    isControlNode: false,
    stepTypeSupported: true,
    isQaStep: false,
    qaRequestChanges: false,
    recoveryActive: false,
    ...overrides,
  };
}

describe("normalizeWorkflowRetryPolicy", () => {
  it("defaults maxRetries to 2 when omitted with onFailure retry", () => {
    const p = normalizeWorkflowRetryPolicy({ onFailure: "retry" });
    expect(p.maxRetries).toBe(2);
    expect(p.enabled).toBe(true);
  });

  it("explicit maxRetries 0 disables generic retry", () => {
    const p = normalizeWorkflowRetryPolicy({ onFailure: "retry", maxRetries: 0 });
    expect(p.enabled).toBe(false);
    expect(p.maxRetries).toBe(0);
  });

  it("non-retry onFailure disables generic retry", () => {
    const p = normalizeWorkflowRetryPolicy({ onFailure: "abort_workflow", maxRetries: 3 });
    expect(p.enabled).toBe(false);
    expect(p.maxRetries).toBe(3);
  });

  it("defaults delay to 0, backoff to fixed, jitter to false", () => {
    const p = normalizeWorkflowRetryPolicy({ onFailure: "retry" });
    expect(p.delaySeconds).toBe(0);
    expect(p.backoff).toBe("fixed");
    expect(p.jitter).toBe(false);
  });

  it("normalizes backoff to lowercase", () => {
    expect(normalizeWorkflowRetryPolicy({ onFailure: "retry", graphRetryBackoff: "Exponential" }).backoff).toBe("exponential");
    expect(normalizeWorkflowRetryPolicy({ onFailure: "retry", graphRetryBackoff: "LINEAR" }).backoff).toBe("linear");
  });

  it("rejects unknown backoff → fixed", () => {
    expect(normalizeWorkflowRetryPolicy({ onFailure: "retry", graphRetryBackoff: "aggressive" }).backoff).toBe("fixed");
  });

  it("floors fractional delay", () => {
    expect(normalizeWorkflowRetryPolicy({ onFailure: "retry", graphRetryDelaySeconds: 3.9 }).delaySeconds).toBe(3);
  });

  it("negative delay → 0", () => {
    expect(normalizeWorkflowRetryPolicy({ onFailure: "retry", graphRetryDelaySeconds: -5 }).delaySeconds).toBe(0);
  });
});

describe("calculateWorkflowRetryDelaySeconds", () => {
  const detRandom = () => 0.5;

  it("fixed = base", () => {
    const p = { delaySeconds: 10, backoff: "fixed" as const, jitter: false };
    expect(calculateWorkflowRetryDelaySeconds(p, 1, detRandom)).toBe(10);
    expect(calculateWorkflowRetryDelaySeconds(p, 3, detRandom)).toBe(10);
  });

  it("linear = base * n", () => {
    const p = { delaySeconds: 10, backoff: "linear" as const, jitter: false };
    expect(calculateWorkflowRetryDelaySeconds(p, 1, detRandom)).toBe(10);
    expect(calculateWorkflowRetryDelaySeconds(p, 2, detRandom)).toBe(20);
    expect(calculateWorkflowRetryDelaySeconds(p, 3, detRandom)).toBe(30);
  });

  it("exponential = base * 2^(n-1)", () => {
    const p = { delaySeconds: 10, backoff: "exponential" as const, jitter: false };
    expect(calculateWorkflowRetryDelaySeconds(p, 1, detRandom)).toBe(10);
    expect(calculateWorkflowRetryDelaySeconds(p, 2, detRandom)).toBe(20);
    expect(calculateWorkflowRetryDelaySeconds(p, 3, detRandom)).toBe(40);
    expect(calculateWorkflowRetryDelaySeconds(p, 4, detRandom)).toBe(80);
  });

  it("base 0 always returns 0 even with jitter", () => {
    const p = { delaySeconds: 0, backoff: "exponential" as const, jitter: true };
    expect(calculateWorkflowRetryDelaySeconds(p, 5, detRandom)).toBe(0);
  });

  it("jitter applies factor [0.8, 1.2]", () => {
    const p = { delaySeconds: 100, backoff: "fixed" as const, jitter: true };
    const lo = calculateWorkflowRetryDelaySeconds(p, 1, () => 0);
    const hi = calculateWorkflowRetryDelaySeconds(p, 1, () => 1);
    expect(lo).toBe(80);   // 100 * 0.8
    expect(hi).toBe(120);  // 100 * 1.2
  });

  it("caps at 24 hours", () => {
    const p = { delaySeconds: 200_000, backoff: "linear" as const, jitter: false };
    expect(calculateWorkflowRetryDelaySeconds(p, 1, detRandom)).toBe(86_400);
  });
});

describe("classifyWorkflowStepRetry", () => {
  it.each([
    ["first retry", classificationInput(), { eligible: true, retryNumber: 1, maxRetries: 2, delaySeconds: 0 }],
    ["second retry", classificationInput({ retryCount: 1 }), { eligible: true, retryNumber: 2, maxRetries: 2, delaySeconds: 0 }],
    ["exhausted", classificationInput({ retryCount: 2 }), { eligible: false, reason: "exhausted" }],
    ["disabled", classificationInput({ policy: policy({ enabled: false }) }), { eligible: false, reason: "disabled" }],
    ["control_node", classificationInput({ isControlNode: true }), { eligible: false, reason: "control_node" }],
    ["qa_rework", classificationInput({ isQaStep: true, qaRequestChanges: true }), { eligible: false, reason: "qa_rework" }],
    ["recovery_active", classificationInput({ recoveryActive: true }), { eligible: false, reason: "recovery_active" }],
    ["malformed_state", classificationInput({ stepRunStatus: "pending" }), { eligible: false, reason: "malformed_state" }],
    ["control before disabled", classificationInput({ isControlNode: true, policy: policy({ enabled: false }) }), { eligible: false, reason: "control_node" }],
    ["delayed retry", classificationInput({ policy: policy({ delaySeconds: 30, backoff: "linear" }), retryCount: 1 }), { eligible: true, retryNumber: 2, maxRetries: 2, delaySeconds: 60 }],
  ] as const)("%s", (_label, input, expected) => {
    expect(classifyWorkflowStepRetry(input, () => 0.5)).toEqual(expected);
  });
});
