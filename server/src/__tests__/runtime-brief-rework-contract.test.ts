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

  it("places a compact CURRENT REWORK TASK block at the very start and suppresses recent comments in rework mode", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipWorkflowReworkContract: {
        kind: "workflow_qa_rework",
        producerStepId: "materialize-html-report",
        iterationLabel: "2/2",
        requiredActions: ["Update the deliverable to reflect the REQUEST_CHANGES."],
        qaFeedbacks: [
          { qaStepId: "qa-dashboard-html", qaIssueId: "GAZ-228", feedback: "REQUEST_CHANGES: missing X" },
        ],
        dependencyArtifacts: null,
      },
      paperclipIssueRecentComments: [
        { id: "c1", authorType: "controller", body: "duplicate-comment-marker-xyz" },
      ],
    });

    // [acceptance] compact 최우선 블록이 brief 선두.
    expect(brief).toContain("=== CURRENT REWORK TASK");
    expect(brief).toContain("Target step: materialize-html-report | iteration 2/2");
    expect(brief).toContain("Latest QA failure");
    expect(brief).toContain("FORBIDDEN: do NOT call /workflow/complete");
    // [acceptance] 헤더가 상세 contract 섹션보다 먼저.
    const headerIdx = brief.indexOf("=== CURRENT REWORK TASK");
    const detailedIdx = brief.indexOf("Workflow rework contract:");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(detailedIdx).toBeGreaterThan(headerIdx);
    // [acceptance] rework 모드에선 최근 코멘트 중복 억제(contract가 QA feedback을 이미 携带).
    expect(brief).not.toContain("duplicate-comment-marker-xyz");
  });
});
