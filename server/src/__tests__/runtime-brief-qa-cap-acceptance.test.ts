import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("QA cap acceptance runtime brief", () => {
  it("explains the opt-in cap decision without weakening blocking QA failures", () => {
    const brief = buildPaperclipRuntimeBrief({
      issueId: "qa-issue-id",
      paperclipQaCapAcceptanceContract: {
        kind: "workflow_qa_cap_acceptance",
        qaStepId: "inspection",
        producerStepId: "materialize-html-report",
        currentIteration: 2,
        maxIterations: 2,
        verdictEndpoint: "/api/issues/qa-issue-id/workflow/verdict",
        nonblockingAcceptance: {
          classification: "nonblocking",
          limitationsRequired: true,
        },
      },
    });

    expect(brief).toContain("QA cap decision contract:");
    expect(brief).toContain("Reinspect the current producer generation");
    expect(brief).toContain("PASS");
    expect(brief).toContain("blocking");
    expect(brief).toContain("Treat a remaining gap as blocking only when it creates material risk");
    expect(brief).toContain("missing or unreadable required output");
    expect(brief).toContain("unsafe or materially false content");
    expect(brief).toContain("downstream consumption, delivery, or verification cannot proceed");
    expect(brief).toContain("Do not classify a gap as blocking merely because a checklist item or canonical probe failed");
    expect(brief).toContain("nonblockingAcceptance");
    expect(brief).toContain("/api/issues/qa-issue-id/workflow/verdict");
    expect(brief).toContain("Do not infer acceptance from comments or transcript text");
  });
});
