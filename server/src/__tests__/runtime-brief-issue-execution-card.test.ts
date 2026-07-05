import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("buildPaperclipRuntimeBrief issue execution card", () => {
  it("summarizes structured issue execution card and instruction injection state", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipIssueExecutionCardHash: "cardhash123",
      paperclipIssueExecutionCard: {
        requiredOutputs: {
          workProduct: { required: true },
          verdict: { required: false },
          deliveryReadback: { required: true },
        },
      },
      paperclipInstructionInjection: {
        mode: "compact",
        contentHash: "instructionhash123",
      },
    });

    expect(brief).toContain("Issue execution card: hash cardhash123");
    expect(brief).toContain("workProduct required=true");
    expect(brief).toContain("delivery readback required=true");
    expect(brief).toContain("Agent instructions injection: compact (instructionhash123)");
  });
});
