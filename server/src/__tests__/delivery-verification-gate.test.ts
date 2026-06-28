// @vitest-environment node
// [Delivery Verification Gate] helper 가 publish/deploy step 감지, duplicate 판정, gate step 생성 검증.

import { describe, expect, it } from "vitest";
import {
  appendDeliveryVerificationCriteria,
  buildDeliveryVerificationCriteria,
  hasExistingDeliveryReadbackStep,
  isDeliveryRelevantStep,
  isDeliveryReadbackStep,
  strengthenDeliveryReadbackSteps,
  synthesizeDeliveryVerificationGateStep,
} from "../services/workflow/delivery-verification-gate.js";

describe("delivery-verification-gate", () => {
  it("isDeliveryRelevantStep: manual-onboarding/public-destination keywords true, generic publish false", () => {
    expect(isDeliveryRelevantStep({ id: "s1", name: "manual-onboarding publisher", description: "" })).toBe(true);
    expect(isDeliveryRelevantStep({ id: "s1", name: "Publish to R2", description: "" })).toBe(true);
    expect(isDeliveryRelevantStep({ id: "s1", name: "Cloudflare pages deploy", description: "" })).toBe(true);
    expect(isDeliveryRelevantStep({ id: "s1", name: "회사게시", description: "" })).toBe(true);
    // generic publish/deploy alone is NOT delivery-relevant (regression prevention)
    expect(isDeliveryRelevantStep({ id: "publish", name: "Publish report", description: "" })).toBe(false);
    expect(isDeliveryRelevantStep({ id: "deploy", name: "Deploy", description: "" })).toBe(false);
    // content QA is NOT delivery-relevant
    expect(isDeliveryRelevantStep({ id: "validate-content", name: "Validate content quality", description: "" })).toBe(false);
  });

  it("hasExistingDeliveryReadbackStep: detects QA+public-marker combo, not generic QA or generic publish", () => {
    // QA + public marker → delivery readback
    expect(hasExistingDeliveryReadbackStep([
      { id: "s1", name: "Publish smoke QA: R2 HTTP 200 + hub index", description: "" },
    ])).toBe(true);
    expect(hasExistingDeliveryReadbackStep([
      { id: "s1", name: "verify publish onboarding hub", description: "" },
    ])).toBe(true);
    // explicit readback keyword
    expect(hasExistingDeliveryReadbackStep([
      { id: "s1", name: "delivery-verification-gate", name2: "", description: "" } as never,
    ])).toBe(true);
    // generic QA without public marker → NOT delivery readback
    expect(hasExistingDeliveryReadbackStep([
      { id: "s1", name: "Validate content quality", description: "" },
    ])).toBe(false);
    // generic publish without QA → NOT delivery readback
    expect(hasExistingDeliveryReadbackStep([
      { id: "s1", name: "Publish report", description: "" },
    ])).toBe(false);
    // no steps
    expect(hasExistingDeliveryReadbackStep([])).toBe(false);
    expect(isDeliveryReadbackStep({
      id: "smoke",
      name: "[QA] 게시 smoke QA: R2 HTTP 200 + hub index 갱신 확인",
      description: "",
    })).toBe(true);
  });

  it("synthesizeDeliveryVerificationGateStep: creates a gate step with readback hard-stop description", () => {
    const gate = synthesizeDeliveryVerificationGateStep({
      dependencyStepIds: ["publish-step-1", "publish-step-2"],
      agentId: "agent-1",
      definitionName: "Test Workflow",
    });
    expect(gate.id).toBe("delivery-verification-gate");
    expect(gate.name).toContain("Delivery Verification");
    expect(gate.dependencies).toEqual(["publish-step-1", "publish-step-2"]);
    expect(gate.graphWorkProductRequired).toBe(false);
    expect(gate.agentId).toBe("agent-1");
    expect(gate.description).toContain("Do NOT pass merely because the publish/deploy step completed");
    expect(gate.description).toContain("Verification Before Completion");
    expect(gate.description).toContain("fresh evidence");
    expect(gate.description).toContain("Do not infer a provider");
    expect(gate.description).toContain("delivery manifest");
    expect(gate.description).toContain("HTTP 200");
    expect(gate.description).toContain("REQUEST_CHANGES");
    expect(gate.description).toContain("PASS");
  });

  it("buildDeliveryVerificationCriteria: produces readback hard-stop text", () => {
    const criteria = buildDeliveryVerificationCriteria();
    expect(criteria).toContain("final destination declared");
    expect(criteria).toContain("final consumer path");
    expect(criteria).toContain("Do not PASS merely because the publish/deploy step completed");
    expect(criteria).toContain("instead of guessing a provider");
    expect(criteria).toContain("HTTP 200");
    expect(criteria).toContain("REQUEST_CHANGES");
  });

  it("strengthens an existing delivery readback step instead of requiring a duplicate gate", () => {
    const steps = strengthenDeliveryReadbackSteps([
      {
        id: "publish",
        name: "manual-onboarding publisher",
        agentId: "agent-1",
        dependencies: [],
      },
      {
        id: "smoke",
        name: "[QA] 게시 smoke QA: R2 HTTP 200 + hub index 갱신 확인",
        agentId: "agent-1",
        dependencies: ["publish"],
        description: "Check the public hub.",
      },
    ]);

    expect(steps[0]!.description).toBeUndefined();
    expect(steps[1]!.description).toContain("Check the public hub.");
    expect(steps[1]!.description).toContain("Delivery Verification:");
    expect(steps[1]!.description).toContain("REQUEST_CHANGES");
    expect(appendDeliveryVerificationCriteria(steps[1]!.description)).toBe(steps[1]!.description);
  });
});
