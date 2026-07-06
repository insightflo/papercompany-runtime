import { describe, expect, it } from "vitest";
import { buildToolStepRecoveryDescription } from "../services/missions/tool-step-recovery-description.js";

describe("tool step recovery description", () => {
  it("includes mission owner decision format for human operator handoff", () => {
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

    expect(description).toContain("Mission owner decision contract:");
    expect(description).toContain("### Mission owner decision");
    expect(description).toContain("Decision: <one of the allowed decision options>");
    expect(description).toContain("Use `Decision: request_input` or `Decision: escalate`");
    expect(description).toContain("Manual recovery result contract:");
  });
});
