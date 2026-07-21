import { describe, expect, it } from "vitest";
import {
  autofillManualOnboardingPublishResult,
  type PublishResultAutofillResult,
} from "../services/missions/mission-plan-publish-result-autofill.js";
import { reviewManualOnboardingVerificationTopology } from "../services/missions/mission-plan-manual-onboarding-contract.js";

function publishUnit(id = "publish"): Record<string, unknown> {
  return {
    id,
    kind: "mission_plan_unit",
    title: "Publish",
    assigneeAgentId: "publisher",
    selectionState: "selected",
    toolNames: ["manual-onboarding-publish"],
    toolArgs: {},
    dependsOn: [],
    graphWorkProductRequired: true,
  };
}

function verifyUnit(id = "verify", dependsOn = ["publish"], toolArgs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "mission_plan_unit",
    title: "Verify",
    assigneeAgentId: "publisher",
    selectionState: "selected",
    toolNames: ["manual-onboarding-verify"],
    toolArgs,
    dependsOn,
    graphWorkProductRequired: false,
  };
}

describe("autofillManualOnboardingPublishResult — canonical autofill", () => {
  it("adds canonical publishResultPath when a single publisher/verifier pair exists and verifier depends on publisher", () => {
    const result = autofillManualOnboardingPublishResult([
      publishUnit(),
      verifyUnit("verify", ["publish"], { timeoutMs: 5000 }),
    ]);
    expect(result.units[1]?.toolArgs).toEqual({
      timeoutMs: 5000,
      publishResultPath: "{$steps.publish.workProductPath}",
    });
    expect(result.applied).toEqual({
      publisherUnitId: "publish",
      verifierUnitId: "verify",
      field: "publishResultPath",
    });
  });

  it("preserves an existing canonical camelCase value and reports no-op", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", ["publish"], { publishResultPath: "{$steps.publish.workProductPath}" }),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.units[1]?.toolArgs).toEqual({ publishResultPath: "{$steps.publish.workProductPath}" });
    expect(result.applied).toBeNull();
  });

  it("does not overwrite a conflicting camelCase value and reports no-op", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", ["publish"], { publishResultPath: "https://example.com/other" }),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.units[1]?.toolArgs).toEqual({ publishResultPath: "https://example.com/other" });
    expect(result.applied).toBeNull();
  });

  it("does not autofill when the dashed form is already present", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", ["publish"], { "publish-result-path": "{$steps.publish.workProductPath}" }),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.units[1]?.toolArgs).toEqual({ "publish-result-path": "{$steps.publish.workProductPath}" });
    expect(result.applied).toBeNull();
  });
});

describe("autofillManualOnboardingPublishResult — topology guards", () => {
  it("does not autofill when multiple publisher units exist", () => {
    const units = [
      publishUnit("publish-a"),
      publishUnit("publish-b"),
      verifyUnit("verify", ["publish-a"], {}),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toBeNull();
    expect(result.units[1]?.toolArgs).toEqual({});
  });

  it("does not autofill when multiple verifier units exist", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify-a", ["publish"], {}),
      verifyUnit("verify-b", ["publish"], {}),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toBeNull();
  });

  it("does not autofill when the verifier does not depend on the publisher", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", [], {}),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toBeNull();
    expect(result.units[1]?.toolArgs).toEqual({});
  });

  it("does not autofill when toolArgs is malformed", () => {
    const units = [
      publishUnit(),
      { ...verifyUnit("verify", ["publish"], {}), toolArgs: "not-an-object" },
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toBeNull();
  });

  it("autofills when dependency is transitive through an intermediate unit", () => {
    const units = [
      publishUnit(),
      { ...verifyUnit("middle", ["publish"], {}), toolNames: ["some-other-tool"] },
      verifyUnit("verify", ["middle"], {}),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toEqual({
      publisherUnitId: "publish",
      verifierUnitId: "verify",
      field: "publishResultPath",
    });
    expect(result.units[2]?.toolArgs).toEqual({
      publishResultPath: "{$steps.publish.workProductPath}",
    });
    // Intermediate unit must not be mutated.
    expect(result.units[1]?.toolArgs).toEqual({});
  });

  it("reports no-op when no publisher or verifier exists", () => {
    const result = autofillManualOnboardingPublishResult([
      { id: "unit-1", toolNames: [], toolArgs: {}, dependsOn: [] },
    ]);
    expect(result.applied).toBeNull();
    expect(result.units).toHaveLength(1);
  });
});

describe("autofillManualOnboardingPublishResult — immutability and validator interaction", () => {
  it("never mutates the input unit objects", () => {
    const publisher = publishUnit();
    const verifier = verifyUnit("verify", ["publish"], { timeoutMs: 5000 });
    const originalVerifierArgs = { timeoutMs: 5000 };
    const original = [publisher, verifier];
    const snapshot = JSON.stringify(original);
    autofillManualOnboardingPublishResult(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(verifier.toolArgs).toEqual(originalVerifierArgs);
  });

  it("returns copied unit objects in every path", () => {
    const original = [publishUnit(), verifyUnit("verify", ["publish"], {})];
    const result = autofillManualOnboardingPublishResult(original);
    expect(result.units).not.toBe(original);
    expect(result.units[0]).not.toBe(original[0]);
    expect(result.units[1]).not.toBe(original[1]);
    expect(result.units[1]?.toolArgs).not.toBe(original[1]?.toolArgs);
  });

  it("no-op result still passes the existing validator topology diagnostic", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", ["publish"], { publishResultPath: "{$steps.publish.workProductPath}" }),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).toBeNull();
    expect(reviewManualOnboardingVerificationTopology(result.units)).toEqual([]);
  });

  it("autofilled result passes the existing validator topology diagnostic", () => {
    const units = [
      publishUnit(),
      verifyUnit("verify", ["publish"], {}),
    ];
    const result = autofillManualOnboardingPublishResult(units);
    expect(result.applied).not.toBeNull();
    expect(reviewManualOnboardingVerificationTopology(result.units)).toEqual([]);
  });

  it("autofilled result satisfies the PublishResultAutofillResult type contract", () => {
    const result: PublishResultAutofillResult = autofillManualOnboardingPublishResult([
      publishUnit(),
      verifyUnit("verify", ["publish"], {}),
    ]);
    expect(Array.isArray(result.units)).toBe(true);
    expect(result.applied === null || typeof result.applied === "object").toBe(true);
  });
});
