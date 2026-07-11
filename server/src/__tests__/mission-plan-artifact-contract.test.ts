import { describe, expect, it } from "vitest";
import { extractMissionIntent } from "../services/missions/mission-intent.js";
import { hasDeliveryActionRole } from "../services/missions/mission-plan-artifact-contract.js";
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
        unit({ id: "publish", title: "Publish guide to site", graphWorkProductRequired: true, toolNames: ["manual-onboarding-publish"], dependsOn: ["qa"], sourceRef: { type: "mission_plan_unit", id: "publish" } }),
        unit({ id: "readback", title: "[QA] Readback published page", graphWorkProductRequired: false, dependsOn: ["publish"], sourceRef: { type: "mission_plan_unit", id: "readback" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_artifact_workproduct_marker");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "invalid")).toEqual([]);
  });

  it("does not treat destination contract checks as delivery actions", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Beginner guide", "Research the topic and publish the guide to the site"),
      selectedExecutionUnits: [
        unit({ id: "check", title: "Confirm manual-onboarding publish contract", graphWorkProductRequired: true, sourceRef: { type: "mission_plan_unit", id: "check" } }),
        unit({ id: "draft", title: "Write guide artifact", graphWorkProductRequired: true, dependsOn: ["check"], sourceRef: { type: "mission_plan_unit", id: "draft" } }),
        unit({ id: "qa", title: "[QA] Validate artifact content", graphWorkProductRequired: false, dependsOn: ["draft"], sourceRef: { type: "mission_plan_unit", id: "qa" } }),
        unit({ id: "publish", title: "Publish guide to site", graphWorkProductRequired: true, toolNames: ["manual-onboarding-publish"], dependsOn: ["qa"], sourceRef: { type: "mission_plan_unit", id: "publish" } }),
        unit({ id: "readback", title: "[QA] Readback published page", graphWorkProductRequired: false, dependsOn: ["publish"], sourceRef: { type: "mission_plan_unit", id: "readback" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_artifact_qa_delivery_order");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "invalid")).toEqual([]);
  });

  it("does not treat ACTION source or research units as artifact QA because of evidence wording", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Manual onboarding concepts", "Research Papercompany concepts and publish them to the site"),
      selectedExecutionUnits: [
        unit({
          id: "source-comments",
          title: "[ACTION] Collect source comments and references",
          reason: "Build the source evidence packet and capture quality caveats for downstream synthesis.",
          graphWorkProductRequired: true,
          sourceRef: { type: "mission_plan_unit", id: "source-comments" },
        }),
        unit({
          id: "workflow-comparison",
          title: "[ACTION] Compare findings against workflow governance and artifact registration rules",
          reason: "Check source coverage and workProduct registration requirements before writing.",
          graphWorkProductRequired: true,
          dependsOn: ["source-comments"],
          sourceRef: { type: "mission_plan_unit", id: "workflow-comparison" },
        }),
        unit({
          id: "concept-html",
          title: "[ACTION] Produce Korean concepts HTML artifact",
          graphWorkProductRequired: true,
          dependsOn: ["workflow-comparison"],
          sourceRef: { type: "mission_plan_unit", id: "concept-html" },
        }),
        unit({
          id: "artifact-qa",
          title: "[QA] Validate produced HTML artifact before publication",
          graphWorkProductRequired: false,
          dependsOn: ["concept-html"],
          sourceRef: { type: "mission_plan_unit", id: "artifact-qa" },
        }),
        unit({
          id: "publish",
          title: "[ACTION] Publish approved HTML concept page",
          graphWorkProductRequired: true,
          toolNames: ["manual-onboarding-publish"],
          dependsOn: ["artifact-qa"],
          sourceRef: { type: "mission_plan_unit", id: "publish" },
        }),
        unit({
          id: "readback",
          title: "[QA] Readback published page",
          graphWorkProductRequired: false,
          dependsOn: ["publish"],
          sourceRef: { type: "mission_plan_unit", id: "readback" },
        }),
      ],
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_artifact_qa_delivery_order");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "invalid")).toEqual([]);
  });

  it("allows prepublish artifact QA followed by delivery readback and final QA", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("GPT guide", "Research and publish a beginner guide to the onboarding site"),
      selectedExecutionUnits: [
        unit({ id: "produce", title: "[ACTION] Produce beginner manual HTML", graphWorkProductRequired: true, sourceRef: { type: "mission_plan_unit", id: "produce" } }),
        unit({ id: "prepublish-qa", title: "[QA] Validate manual claims and evidence", graphWorkProductRequired: false, dependsOn: ["produce"], sourceRef: { type: "mission_plan_unit", id: "prepublish-qa" } }),
        unit({ id: "publish", title: "[ACTION] Publish approved manual", graphWorkProductRequired: true, toolNames: ["manual-onboarding-publish"], dependsOn: ["prepublish-qa"], sourceRef: { type: "mission_plan_unit", id: "publish" } }),
        unit({ id: "verify", title: "[ACTION] Verify published manual destination readback", graphWorkProductRequired: true, toolNames: ["manual-onboarding-verify"], dependsOn: ["publish"], sourceRef: { type: "mission_plan_unit", id: "verify" } }),
        unit({ id: "final-qa", title: "[QA] Audit destination readback and final delivery evidence", graphWorkProductRequired: false, dependsOn: ["verify"], sourceRef: { type: "mission_plan_unit", id: "final-qa" } }),
      ],
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "invalid")).toEqual([]);
  });

  it("requires a delivery tool instead of publish wording alone", () => {
    const diagnostics = reviewPlanAgainstIntent({
      intent: extractMissionIntent("Beginner guide", "Research the topic and publish the guide to the site"),
      selectedExecutionUnits: [
        unit({ id: "draft", title: "Write guide artifact", graphWorkProductRequired: true, sourceRef: { type: "mission_plan_unit", id: "draft" } }),
        unit({ id: "qa", title: "[QA] Validate artifact content", graphWorkProductRequired: false, dependsOn: ["draft"], sourceRef: { type: "mission_plan_unit", id: "qa" } }),
        unit({ id: "publish", title: "Publish guide to site", graphWorkProductRequired: true, dependsOn: ["qa"], sourceRef: { type: "mission_plan_unit", id: "publish" } }),
        unit({ id: "readback", title: "[QA] Readback published page", graphWorkProductRequired: false, dependsOn: ["publish"], sourceRef: { type: "mission_plan_unit", id: "readback" } }),
      ],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_publish_unit");
  });

  it("recognizes publisher tool names as delivery actions", () => {
    expect(hasDeliveryActionRole(unit({ toolNames: ["manual-onboarding-publisher"] }))).toBe(true);
  });
});
