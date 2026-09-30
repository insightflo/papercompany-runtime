import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJsonForSave } from "./step-draft.js";
import { workflowStepDefinitionSchema } from "@paperclipai/shared";

describe("artifact contract editor roundtrip", () => {
  it("preserves typed selection and tool artifact contracts through the extra-field bag", () => {
    const input = { id: "qa", title: "QA", type: "tool" as const, toolName: "qa", toolArgs: {},
      workProductSelectors: { draft: { type: "document", title: "content.json" } },
      toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "draft" } };
    const drafts = jsonToSteps([input]); drafts[0].title = "Edited QA";
    const result = stepsToJsonForSave(drafts);
    expect(result).not.toHaveProperty("error");
    if (!("steps" in result)) throw new Error(result.error);
    const saved = result.steps[0] as Record<string, unknown>;
    expect(saved.workProductSelectors).toEqual(input.workProductSelectors);
    expect(saved.toolArtifactContract).toEqual(input.toolArtifactContract);
    expect(workflowStepDefinitionSchema.parse(saved)).toMatchObject({ workProductSelectors: input.workProductSelectors, toolArtifactContract: input.toolArtifactContract });
  });
});
