import { describe, expect, it } from "vitest";
import { buildToolStepRecoveryDescription } from "../services/missions/tool-step-recovery-description.js";

describe("tool step recovery description", () => {
  it("directs recovery decisions to the structured API", () => {
    const description = buildToolStepRecoveryDescription({
      marker: "tool-step-recovery:run-1:sync-dashboard",
      missionTitle: "Daily dashboard",
      workflowName: "gazua-morning",
      workflowRunId: "run-1",
      stepId: "sync-dashboard",
      displayStepName: "Sync dashboard",
      toolNames: ["gazua.oracle-data-sync"],
      classification: {
        className: "side_effect_risk",
        retryPolicy: "manual_owner_decision_required",
        rationale: "External side effect risk.",
        requiredAction: "Owner must decide whether retry is safe.",
        evidence: [],
      },
    });

    expect(description).not.toContain("Local retry hint:");
    expect(description).not.toContain("manual_owner_decision_required");
    expect(description).toContain("text-based guess");
    expect(description).toContain("Mission owner decision authority:");
    expect(description).toContain("POST /api/issues/{this owner-action issue id}/owner-recovery/decision");
    expect(description).toContain("Optional display-only comment template");
    expect(description).toContain("a comment cannot authorize recovery");
    expect(description).toContain("Manual recovery evidence:");
    expect(description).toContain("active workProduct is registered through the official workflow API");
    expect(description).toContain("ordinary issue comments are display-only evidence");
  });

  it("states the changed-bytes rule for producer work products", () => {
    const description = buildToolStepRecoveryDescription({
      marker: "tool-step-recovery:run-1:qa-gate",
      missionTitle: "Daily dashboard",
      workflowName: "gazua-morning",
      workflowRunId: "run-1",
      stepId: "qa-gate",
      displayStepName: "QA gate",
      toolNames: ["gazua.qa"],
      classification: {
        className: "side_effect_risk",
        retryPolicy: "manual_owner_decision_required",
        rationale: "External side effect risk.",
        requiredAction: "Owner must decide whether retry is safe.",
        evidence: [],
      },
    });

    expect(description).toContain("If the producer work-product file bytes were modified directly");
    expect(description).toContain("producer_rebind_bytes_changed");
    expect(description).toContain("adopt_producer_edits");
    expect(description).toContain("attestation {sha256, byteSize}");
    expect(description).toContain("Adoption and the exact retry commit together; a refused retry rolls the adoption back");
    expect(description).toContain("rerun the producer step, or register a corrected revision through the official producer registration path");
    expect(description).toContain("submit `request_input` or `escalate`");
  });

  it("tells owners to state a grounded recommendation when handing a choice to a human", () => {
    const description = buildToolStepRecoveryDescription({
      marker: "tool-step-recovery:run-1:qa-gate",
      missionTitle: "Daily dashboard",
      workflowName: "gazua-morning",
      workflowRunId: "run-1",
      stepId: "qa-gate",
      displayStepName: "QA gate",
      toolNames: ["gazua.qa"],
      classification: {
        className: "side_effect_risk",
        retryPolicy: "manual_owner_decision_required",
        rationale: "External side effect risk.",
        requiredAction: "Owner must decide whether retry is safe.",
        evidence: [],
      },
    });
    expect(description).toContain("recommendedOptionId");
    expect(description).toContain("recommendationReason");
    expect(description).toContain("state which option you recommend and why");
  });

  it("keeps toolInvocationArgs evidence visible (empty-args definition defects) with secrets redacted", () => {
    const build = (evidence: string[]) => buildToolStepRecoveryDescription({
      marker: "m", missionTitle: "t", workflowName: "w", workflowRunId: "run-1", stepId: "s",
      displayStepName: "S", toolNames: ["x"],
      classification: { className: "unknown", retryPolicy: "manual_owner_decision_required", rationale: "r", requiredAction: "a", evidence },
    });
    expect(build(["toolInvocationArgs: {}"])).toContain("- toolInvocationArgs: {}");
    const withSecret = build(['toolInvocationArgs: {"date":"2026-10-03","apiKey":"SENTINEL_SECRET_123"}']);
    expect(withSecret).toContain("toolInvocationArgs:");
    expect(withSecret).toContain("2026-10-03");
    expect(withSecret).not.toContain("SENTINEL_SECRET_123");
  });
});
