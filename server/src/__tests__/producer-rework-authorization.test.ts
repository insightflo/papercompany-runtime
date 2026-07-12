import { describe, expect, it } from "vitest";
import { authorizeProducerRework } from "../services/missions/producer-rework-authorization.js";

const producerCompletedAt = new Date("2026-01-01T00:00:00Z");
const freshVerdictAt = new Date("2026-01-01T01:00:00Z");
const staleVerdictAt = new Date("2025-12-31T23:00:00Z");

describe("authorizeProducerRework", () => {
  it("explicit owner rework target is authorized and takes precedence over guardrail", () => {
    const result = authorizeProducerRework({
      ownerReworkRef: "RES-2001",
      failureReasonCode: "STEP_INPUT_MANIFEST_GUARDRAIL",
    });
    expect(result).toEqual({ authorized: true, reason: "explicit_rework_target", reworkTargetRef: "RES-2001" });
  });

  it("STEP_INPUT_MANIFEST_GUARDRAIL failure without owner target is unauthorized (self-policy, not a producer defect)", () => {
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      failureReasonCode: "STEP_INPUT_MANIFEST_GUARDRAIL",
    });
    expect(result).toEqual({ authorized: false, reason: "step_input_manifest_guardrail" });
  });

  it("fresh request_changes verdict (observedAt >= producerCompletedAt) is authorized", () => {
    const verdicts = new Map([["qa-1", { verdict: "request_changes", observedAt: freshVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt,
    });
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("fresh_request_changes_verdict");
  });

  it("request_changes verdict without producerCompletedAt is unauthorized — current generation unverified", () => {
    const verdicts = new Map([["qa-1", { verdict: "request_changes", observedAt: freshVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt: null,
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("current_generation_unverified");
  });

  it("stale request_changes verdict (observedAt < producerCompletedAt) is unauthorized", () => {
    const verdicts = new Map([["qa-1", { verdict: "request_changes", observedAt: staleVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt,
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("stale_or_absent_verdict");
  });

  it("DAG guess with no verdict is unauthorized (RES-1315 core block)", () => {
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: new Map(),
      producerCompletedAt,
    });
    expect(result).toEqual({ authorized: false, reason: "dag_guess_without_verdict" });
  });

  it("a pass verdict alone (no owner ref) is unauthorized", () => {
    const verdicts = new Map([["qa-1", { verdict: "pass", observedAt: freshVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt,
    });
    expect(result.authorized).toBe(false);
  });

  it("a whitespace-only rework ref is treated as absent", () => {
    const result = authorizeProducerRework({ ownerReworkRef: "   " });
    expect(result.authorized).toBe(false);
  });

  it("recovery died with no verdict routes to request_replan, not producer reopen", () => {
    const result = authorizeProducerRework({ ownerReworkRef: null });
    expect(result).toEqual({ authorized: false, reason: "dag_guess_without_verdict" });
  });

  it("explicit target wins even when verdict map is stale", () => {
    const verdicts = new Map([["qa-1", { verdict: "request_changes", observedAt: staleVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: "RES-2001",
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt,
    });
    expect(result).toEqual({ authorized: true, reason: "explicit_rework_target", reworkTargetRef: "RES-2001" });
  });

  it("fresh request_changes verdict authorizes rework even when a guardrail failure code is present", () => {
    const verdicts = new Map([["qa-1", { verdict: "request_changes", observedAt: freshVerdictAt }]]);
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      failureReasonCode: "step_input_manifest_guardrail",
      qaIssueId: "qa-1",
      validationVerdictsByIssueId: verdicts,
      producerCompletedAt,
    });
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe("fresh_request_changes_verdict");
  });

  it("guardrail without a fresh official request_changes is unauthorized (QA self-recovery)", () => {
    const result = authorizeProducerRework({
      ownerReworkRef: null,
      failureReasonCode: "step_input_manifest_guardrail",
      producerCompletedAt,
    });
    expect(result).toEqual({ authorized: false, reason: "step_input_manifest_guardrail" });
  });
});
