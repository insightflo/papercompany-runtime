import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

const header = "Unconsumed operator instructions (highest priority — apply before other work):";

describe("unconsumed operator instructions runtime brief", () => {
  it("adds timestamped instructions independently of recent comments without re-truncation", () => {
    const body = "x".repeat(600);
    const brief = buildPaperclipRuntimeBrief({
      paperclipOperatorInstructionsUnconsumed: [{ id: "one", createdAt: "2026-09-26T08:00:00.000Z", body }],
      paperclipIssueRecentComments: [{ id: "two", authorType: "agent", body: "recent reply" }],
    });
    expect(brief).toContain(header);
    expect(brief).toContain(`- [2026-09-26T08:00:00.000Z] ${body}`);
    expect(brief).toContain("Recent issue comments:");
    expect(brief).toContain("recent reply");
  });

  it("retains operator instructions ahead of rework instructions", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipOperatorInstructionsUnconsumed: [{ id: "one", createdAt: "2026-09-26T08:00:00.000Z", body: "Stop scanning" }],
      paperclipWorkflowReworkContract: {
        kind: "workflow_qa_rework", producerStepId: "build", iterationLabel: "2/2",
        requiredActions: ["Fix output"],
        qaFeedbacks: [{ qaStepId: "qa-check", feedback: "REQUEST_CHANGES: Fix output" }],
        dependencyArtifacts: null,
      },
    });
    expect(brief).toContain("Stop scanning");
    expect(brief.indexOf(header)).toBeLessThan(brief.indexOf("=== CURRENT REWORK TASK"));
  });

  it.each([undefined, []])("omits the section when no instructions exist (%s)", (value) => {
    expect(buildPaperclipRuntimeBrief({ paperclipOperatorInstructionsUnconsumed: value })).not.toContain(header);
  });
});
