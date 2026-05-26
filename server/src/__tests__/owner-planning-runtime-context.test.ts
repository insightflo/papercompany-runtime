import { describe, expect, it } from "vitest";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("owner planning runtime context surfaces", () => {
  it("summarizes owner-planning context in the Step Input Manifest without exposing raw execution-unit refs", () => {
    const manifest = buildStepInputManifest({
      taskKey: "mission:mission-1",
      context: {
        issueId: "issue-plan-1",
        missionId: "mission-1",
        paperclipMissionOwnerPlanningContext: {
          planningIssueId: "issue-plan-1",
          mission: { id: "mission-1", title: "Plan launch" },
          activePlan: { available: true, selectedExecutionUnitCount: 2 },
          executionSourceSnapshot: { units: [{ id: "unit-1" }] },
          refs: {
            selectedExecutionUnits: [
              {
                id: "unit-1",
                reason: "raw private rationale must not be mirrored in manifest",
                body: "raw private body must not be mirrored in manifest",
                evidenceRefs: ["secret-evidence"],
              },
            ],
          },
        },
      },
    });

    expect(manifest.allowedContextKeys).toContain("paperclipMissionOwnerPlanningContext");
    expect(manifest.inputs.missionOwnerPlanningContext).toEqual({
      available: true,
      planningIssueId: "issue-plan-1",
      missionId: "mission-1",
      activePlanAvailable: true,
      selectedExecutionUnitCount: 2,
      executionSourceUnitCount: 1,
    });
    expect(JSON.stringify(manifest)).not.toContain("raw private rationale");
    expect(JSON.stringify(manifest)).not.toContain("raw private body");
    expect(JSON.stringify(manifest)).not.toContain("secret-evidence");
  });

  it("summarizes owner-planning context in runtime brief without exposing raw execution-unit refs", () => {
    const brief = buildPaperclipRuntimeBrief({
      issueId: "issue-plan-1",
      missionId: "mission-1",
      paperclipStepInputManifest: buildStepInputManifest({
        taskKey: "mission:mission-1",
        context: {
          issueId: "issue-plan-1",
          missionId: "mission-1",
          paperclipMissionOwnerPlanningContext: {
            planningIssueId: "issue-plan-1",
            mission: { id: "mission-1", title: "Plan launch" },
            activePlan: { available: true, selectedExecutionUnitCount: 2 },
            executionSourceSnapshot: { units: [{ id: "unit-1" }] },
            refs: {
              selectedExecutionUnits: [
                {
                  id: "unit-1",
                  reason: "raw private rationale must not be mirrored in brief",
                  body: "raw private body must not be mirrored in brief",
                  evidenceRefs: ["secret-evidence"],
                },
              ],
            },
          },
        },
      }),
    });

    expect(brief).toContain("- Mission owner planning context: mission mission-1, planning issue issue-plan-1, active plan yes, selected units 2, execution source units 1");
    expect(JSON.stringify(brief)).not.toContain("raw private rationale");
    expect(JSON.stringify(brief)).not.toContain("raw private body");
    expect(JSON.stringify(brief)).not.toContain("secret-evidence");
  });
});
