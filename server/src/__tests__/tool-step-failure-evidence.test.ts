import { describe, expect, it } from "vitest";
import { toolStepFailureEvidence } from "../services/missions/tool-step-failure.js";

function makeStepRun(metadata: Record<string, unknown>) {
  return { id: "sr-1", workflowRunId: "r-1", stepId: "s-1", metadata } as never;
}

describe("toolStepFailureEvidence — invocation args visibility", () => {
  it("surfaces the dispatched tool args (the owner's diagnosis key)", () => {
    const evidence = toolStepFailureEvidence(makeStepRun({
      toolInvocation: { requestId: "req-1", toolName: "validate-gazua-report-html", args: { dir: "/x", glob: "*.html" } },
      toolResult: { error: "boom", exitCode: 2, toolName: "validate-gazua-report-html" },
    }));
    expect(evidence.some((line) => line.startsWith("toolInvocationArgs: ") && line.includes("\"dir\"") && line.includes("/x"))).toBe(true);
  });

  it("makes EMPTY args explicitly visible — empty args are the root-cause signal", () => {
    const evidence = toolStepFailureEvidence(makeStepRun({
      toolInvocation: { requestId: "req-1", toolName: "validate-gazua-report-html", args: {} },
      toolResult: { error: "boom", exitCode: 2, toolName: "validate-gazua-report-html" },
    }));
    expect(evidence).toContain("toolInvocationArgs: {}");
  });

  it("omits the line when no invocation was recorded", () => {
    const evidence = toolStepFailureEvidence(makeStepRun({}));
    expect(evidence.some((line) => line.startsWith("toolInvocationArgs:"))).toBe(false);
  });
});
