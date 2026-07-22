import { describe, expect, it } from "vitest";
import { buildPlanQaReviewDescription } from "../services/missions/mission-plan-review-description.js";
import {
  reselectUnavailableQaAssignees,
  selectedPlanQaReviewerAgentId,
} from "../services/missions/plan-qa-reviewer-selection.js";

describe("PLAN-QA replacement selection", () => {
  it("honors supported tool and skill aliases", () => {
    const result = reselectUnavailableQaAssignees({
      selectedExecutionUnits: [{
        id: "qa-unit",
        title: "[QA] Verify publication",
        assigneeAgentId: "failed-reviewer",
        toolName: "fetch-publication",
        skills: ["publication-review"],
      }],
      runnableCandidates: [
        { agentId: "no-tool", name: "No Tool", role: "qa", capabilities: null, desiredSkillKeys: ["publication-review"], toolNames: [] },
        { agentId: "qualified", name: "Qualified", role: "researcher", capabilities: null, desiredSkillKeys: ["skills/publication-review"], toolNames: ["fetch-publication"] },
      ],
    });

    expect(result.replacements[0]?.toAgentId).toBe("qualified");
  });

  it("prefers required skill coverage before a generic QA role", () => {
    const result = reselectUnavailableQaAssignees({
      selectedExecutionUnits: [{
        id: "qa-unit",
        title: "[QA] Verify publication",
        assigneeAgentId: "failed-reviewer",
        skillRefs: ["publication-review"],
      }],
      runnableCandidates: [
        { agentId: "generic-qa", name: "Generic QA", role: "qa", capabilities: null, desiredSkillKeys: [], toolNames: [] },
        { agentId: "skilled-researcher", name: "Skilled", role: "researcher", capabilities: null, desiredSkillKeys: ["publication-review"], toolNames: [] },
      ],
    });

    expect(result.replacements[0]?.toAgentId).toBe("skilled-researcher");
  });

  it("does not assign a reviewer that lacks a required skill", () => {
    const result = reselectUnavailableQaAssignees({
      selectedExecutionUnits: [{
        id: "qa-unit",
        title: "[QA] Verify publication",
        assigneeAgentId: "failed-reviewer",
        skillRefs: ["publication-review"],
      }],
      runnableCandidates: [
        { agentId: "generic-qa", name: "Generic QA", role: "qa", capabilities: null, desiredSkillKeys: [], toolNames: [] },
      ],
    });

    expect(result.replacements).toEqual([]);
  });

  it("does not rewrite a cross-company QA owner as a local reviewer", () => {
    const input = {
      selectedExecutionUnits: [{
        id: "remote-qa-unit",
        title: "[QA] External company review",
        agentId: "remote-owner",
        sourceRef: { type: "cross_company_mission" },
      }],
      runnableCandidates: [
        { agentId: "local-qa", name: "Local QA", role: "qa", capabilities: null, desiredSkillKeys: [], toolNames: [] },
      ],
    };

    const result = reselectUnavailableQaAssignees(input);

    expect(result.replacements).toEqual([]);
    expect(result.units[0]?.agentId).toBe("remote-owner");
    expect(selectedPlanQaReviewerAgentId(input)).toBeUndefined();
  });
});

describe("PLAN-QA selected-template checklist", () => {
  it("renders every selected template instruction as one exhaustive checklist", () => {
    const description = buildPlanQaReviewDescription({
      missionTitle: "Publish a report",
      missionDescription: "Produce and publish a report.",
      selectedPlanTemplates: [{
        id: "11111111-1111-4111-8111-111111111111",
        name: "Report contract",
        instructions: "Bind the source path.\nCheck every reference field.\nVerify the public destination.",
      }],
    });

    expect(description).toContain("Evaluate every selected-template checklist item before deciding the verdict");
    expect(description).toContain("[template:11111111-1111-4111-8111-111111111111:item:1] Bind the source path.");
    expect(description).toContain("[template:11111111-1111-4111-8111-111111111111:item:2] Check every reference field.");
    expect(description).toContain("[template:11111111-1111-4111-8111-111111111111:item:3] Verify the public destination.");
    expect(description).toContain("Return all blocking template failures together in one REQUEST_CHANGES verdict");
  });
});
