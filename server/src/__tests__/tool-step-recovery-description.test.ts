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

    expect(description).toContain("Mission owner decision authority:");
    expect(description).toContain("POST /api/issues/{this owner-action issue id}/owner-recovery/decision");
    expect(description).toContain("Optional display-only comment template");
    expect(description).toContain("a comment cannot authorize recovery");
    expect(description).toContain("Manual recovery evidence:");
    expect(description).toContain("active workProduct is registered through the official workflow API");
    expect(description).toContain("ordinary issue comments are display-only evidence");
  });
});
