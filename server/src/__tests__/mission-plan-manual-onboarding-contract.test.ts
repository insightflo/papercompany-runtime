import { describe, expect, it } from "vitest";
import { extractMissionIntent } from "../services/missions/mission-intent.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";

function unit(overrides: Record<string, unknown>): Record<string, unknown> {
  return { kind: "mission_plan_unit", selectionState: "selected", ...overrides };
}

const intent = extractMissionIntent("Beginner guide", "Research and publish the guide to the site");
const baseUnits = [
  unit({ id: "build", title: "[ACTION] Build HTML artifact" }),
  unit({ id: "artifact-qa", title: "[QA] Validate HTML artifact", dependsOn: ["build"] }),
  unit({
    id: "publish", title: "[ACTION] Publish HTML", toolNames: ["manual-onboarding-publish"],
    dependsOn: ["artifact-qa"],
  }),
];

describe("manual-onboarding mission plan verification contract", () => {
  it("accepts a downstream verifier that consumes the publisher workProduct", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [...baseUnits, unit({
        id: "verify", title: "[QA] Verify published destination", toolNames: ["manual-onboarding-verify"],
        toolArgs: { publishResultPath: "{$steps.publish.workProductPath}" }, dependsOn: ["publish"],
      })],
    });

    expect(diagnostics.map(({ code }) => code)).not.toContain("missing_manual_onboarding_verify_tool");
  });

  it("rejects a verifier that guesses URLs instead of consuming the publish result", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [...baseUnits, unit({
        id: "verify", title: "[QA] Verify published destination", toolNames: ["manual-onboarding-verify"],
        dependsOn: ["publish"],
      })],
    });

    expect(diagnostics.map(({ code }) => code)).toContain("missing_manual_onboarding_verify_tool");
  });

  it("rejects a verifier that references a different producer", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent,
      selectedExecutionUnits: [...baseUnits, unit({
        id: "verify", title: "[QA] Verify published destination", toolNames: ["manual-onboarding-verify"],
        toolArgs: { publishResultPath: "{$steps.build.workProductPath}" }, dependsOn: ["publish"],
      })],
    });

    expect(diagnostics.map(({ code }) => code)).toContain("missing_manual_onboarding_verify_tool");
  });
});
