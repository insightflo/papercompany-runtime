import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("workflow rework runtime brief", () => {
  it("surfaces workflow rework contract as the current run priority", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipWorkflowReworkContract: {
        kind: "workflow_qa_rework",
        producerStepId: "materialize-html-report",
        iterationLabel: "2/2",
        requiredActions: [
          "Treat this rework contract as the primary instruction for the current run.",
          "Do not close as already complete unless the requested changes are reflected in the deliverable.",
        ],
        qaFeedbacks: [
          {
            qaStepId: "qa-dashboard-html",
            qaIssueId: "GAZ-228",
            feedback: "REQUEST_CHANGES: Risk-Off still permits starter/new-entry action.",
          },
        ],
        dependencyArtifacts: "- blog: /srv/papercompany/projects/gazua-dashboard/reports/beginner_html/dashboard",
      },
    });

    expect(brief).toContain("Workflow rework contract:");
    expect(brief).toContain("Rework target: materialize-html-report (2/2)");
    expect(brief).toContain("Current run priority: resolve the latest REQUEST_CHANGES");
    expect(brief).toContain("qa-dashboard-html (GAZ-228)");
    expect(brief).toContain("Risk-Off still permits starter/new-entry action");
    expect(brief).toContain("Current dependency artifacts:");
  });
});
