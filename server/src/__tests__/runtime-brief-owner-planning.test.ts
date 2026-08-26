import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("buildPaperclipRuntimeBrief mission owner planning protocol", () => {
  it("tells planners to omit optional self-improvement candidates unless they have valid objects", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipStepInputManifest: {
        inputs: {
          missionOwnerPlanningContext: {
            available: true,
            planningIssueId: "issue-plan-1",
            missionId: "mission-1",
            activePlanAvailable: false,
            selectedExecutionUnitCount: 0,
            executionSourceUnitCount: 0,
            planningDossierAssetCounts: {
              workflowCandidates: 0,
              tools: 0,
              runtimeServices: 0,
              ruleRefs: 0,
              kbRefs: 0,
              agentRoster: 0,
              fileViews: 0,
              executionSourceUnits: 0,
            },
            planningDossierGapCount: 0,
            planningDossierSevereGapCount: 0,
          },
        },
      },
    });

    expect(brief).toContain("Do not include `selfImprovementCandidates` unless every entry follows the full self-improvement candidate object contract.");
    expect(brief).not.toContain('"selfImprovementCandidates": []');
  });

  it("tells planners to propose missing capabilities as tool-gap candidates instead of improvising", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipStepInputManifest: {
        inputs: {
          missionOwnerPlanningContext: {
            available: true,
            planningIssueId: "issue-plan-1",
            missionId: "mission-1",
            activePlanAvailable: false,
            selectedExecutionUnitCount: 0,
            executionSourceUnitCount: 0,
            planningDossierAssetCounts: {
              workflowCandidates: 0,
              tools: 0,
              runtimeServices: 0,
              ruleRefs: 0,
              kbRefs: 0,
              agentRoster: 0,
              fileViews: 0,
              executionSourceUnits: 0,
            },
            planningDossierGapCount: 0,
            planningDossierSevereGapCount: 0,
          },
        },
      },
    });

    expect(brief).toContain("Before improvising an answer that needs a missing capability, check existing tools/skills first; propose the gap as a `tool` assetType self-improvement candidate with `toolGap.capability` and `toolGap.existingToolsTried`.");
  });
});
