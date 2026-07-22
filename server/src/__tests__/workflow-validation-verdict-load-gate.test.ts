import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import {
  shouldLoadValidationVerdictsForRun,
  type ValidationVerdictGateStep,
  type ValidationVerdictGateStepRun,
} from "../services/workflow/validation-verdict-load-gate.js";

const plainWorkflowSteps: ValidationVerdictGateStep[] = [
  { id: "build", type: "tool", onFailure: "abort_workflow" },
];
const plainWorkflowRuns: ValidationVerdictGateStepRun[] = [
  { stepId: "build", status: "failed", issueId: null },
];
const qaRetryStep: WorkflowStep = {
  id: "qa",
  type: "tool",
  title: "[QA] Semantic",
  onFailure: "retry",
  maxRetries: 2,
};
const gateCompatibleStep: ValidationVerdictGateStep = qaRetryStep;
void gateCompatibleStep;

describe("shouldLoadValidationVerdictsForRun", () => {
  it("returns false for legacy plain workflows with no QA retry or conditional edges", () => {
    expect(shouldLoadValidationVerdictsForRun(plainWorkflowSteps, plainWorkflowRuns)).toBe(false);
  });

  it("returns true when the workflow has conditional edges", () => {
    const steps: ValidationVerdictGateStep[] = [
      { id: "rescue", conditionalDependencies: [{ stepId: "build", when: "failure" }] },
    ];
    const stepRuns: ValidationVerdictGateStepRun[] = [
      { stepId: "rescue", status: "pending", issueId: null },
    ];
    expect(shouldLoadValidationVerdictsForRun(steps, stepRuns)).toBe(true);
  });

  it("returns true for failed issue-backed QA-like steps with active generic retry", () => {
    const steps: ValidationVerdictGateStep[] = [gateCompatibleStep];
    const stepRuns: ValidationVerdictGateStepRun[] = [
      { stepId: "qa", status: "failed", issueId: "issue-1" },
    ];
    expect(shouldLoadValidationVerdictsForRun(steps, stepRuns)).toBe(true);
  });

  it("returns false for failed QA-like steps when generic retry is disabled or issue-less", () => {
    const disabledSteps: ValidationVerdictGateStep[] = [
      { id: "qa", title: "[QA] Semantic", onFailure: "retry", maxRetries: 0 },
    ];
    expect(shouldLoadValidationVerdictsForRun(disabledSteps, [{ stepId: "qa", status: "failed", issueId: "issue-1" }])).toBe(false);
    expect(shouldLoadValidationVerdictsForRun([gateCompatibleStep], [{ stepId: "qa", status: "failed", issueId: null }])).toBe(false);
  });
});
