import { describe, expect, it } from "vitest";
import { extractMissionIntent } from "../services/missions/mission-intent.js";
import { reviewPlanAgainstIntent } from "../services/missions/mission-plan-qa.js";

function unit(overrides: Record<string, unknown>): Record<string, unknown> {
  return { kind: "mission_plan_unit", selectionState: "selected", ...overrides };
}

describe("mission plan artifact workProduct contract", () => {
  it("rejects a producer marked as not requiring a workProduct", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Beginner guide", "Research the topic and publish the guide to the site"),
      selectedExecutionUnits: [
        unit({ id: "research", title: "Research source material", sourceRef: { type: "mission_plan_unit", id: "research" } }),
        unit({ id: "synthesize", title: "Generate HTML report artifact", graphWorkProductRequired: false, dependsOn: ["research"], sourceRef: { type: "mission_plan_unit", id: "synthesize" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_artifact_workproduct_marker");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "invalid_artifact_workproduct_marker")?.severity).toBe("invalid");
  });

  it("rejects a producer marked false even when the mission has no publish intent", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Internal research report", "Summarize market research findings"),
      selectedExecutionUnits: [
        unit({ id: "research", title: "Collect market notes", sourceRef: { type: "mission_plan_unit", id: "research" } }),
        unit({ id: "report", title: "Write internal report artifact", graphWorkProductRequired: false, dependsOn: ["research"], sourceRef: { type: "mission_plan_unit", id: "report" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_artifact_workproduct_marker");
  });

  it("allows pure condition and QA units marked as not requiring workProducts", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Beginner guide", "Research the topic and publish the guide to the site"),
      selectedExecutionUnits: [
        unit({ id: "check", title: "Confirm input scope and blocker policy", graphWorkProductRequired: false, sourceRef: { type: "mission_plan_unit", id: "check" } }),
        unit({ id: "draft", title: "Write guide artifact", graphWorkProductRequired: true, dependsOn: ["check"], sourceRef: { type: "mission_plan_unit", id: "draft" } }),
        unit({ id: "qa", title: "[QA] Validate artifact content", graphWorkProductRequired: false, dependsOn: ["draft"], sourceRef: { type: "mission_plan_unit", id: "qa" } }),
        unit({ id: "publish", title: "Publish guide to site", graphWorkProductRequired: true, dependsOn: ["qa"], sourceRef: { type: "mission_plan_unit", id: "publish" } }),
        unit({ id: "readback", title: "[QA] Readback published page", graphWorkProductRequired: false, dependsOn: ["publish"], sourceRef: { type: "mission_plan_unit", id: "readback" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_artifact_workproduct_marker");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "invalid")).toEqual([]);
  });
});
