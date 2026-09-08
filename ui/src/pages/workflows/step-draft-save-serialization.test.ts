// @vitest-environment node

import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJsonForSave } from "./step-draft.js";

describe("workflow step save serialization", () => {
  it("rejects invalid tool args instead of replacing them with an empty object", () => {
    const [draft] = jsonToSteps([{
      id: "publish",
      title: "Publish report",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
    }]);
    draft.toolArgs = "```json\n{\"section\":\"tech-scout\"}\n```";

    const result = stepsToJsonForSave([draft]);

    expect(result).toEqual({
      error: expect.stringContaining('Tool step "publish"의 Tool Args JSON 파싱 실패:'),
    });
  });

  it("emits targetWorkflowId when a workflow step carries one", () => {
    const [draft] = jsonToSteps([{
      id: "run-child",
      title: "Run child workflow",
      type: "workflow",
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    }]);
    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error("expected steps result");
    expect(result.steps[0]).toMatchObject({
      type: "workflow",
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
  });

  it("keeps a missing targetWorkflowId as an empty draft field and omits it from saved json", () => {
    const [draft] = jsonToSteps([{ id: "run-child", title: "Run child workflow", type: "workflow" }]);
    expect(draft.targetWorkflowId).toBe("");
    const result = stepsToJsonForSave([draft]);
    if (!("steps" in result)) throw new Error("expected steps result");
    expect(result.steps[0]).not.toHaveProperty("targetWorkflowId");
  });
});
