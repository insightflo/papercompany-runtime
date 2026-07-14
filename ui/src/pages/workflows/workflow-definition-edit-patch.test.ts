// @vitest-environment node

import { describe, expect, it } from "vitest";
import { jsonToSteps } from "./step-draft.js";
import { buildWorkflowDefinitionEditPatch } from "./workflow-definition-edit-patch.js";

describe("workflow definition edit patch", () => {
  it("blocks saving a structured draft with invalid tool args JSON", () => {
    const editingSteps = jsonToSteps([{
      id: "publish",
      title: "Publish report",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
    }]);
    editingSteps[0].toolArgs = "{ invalid";

    const result = buildWorkflowDefinitionEditPatch({
      name: "tech-scout",
      description: "",
      status: "active",
      triggerLabels: "",
      labelIds: [],
      schedule: "",
      maxDailyRuns: "",
      timezone: "Asia/Seoul",
      projectId: "",
      createParentIssuePolicy: "when_multiple_steps",
      editStepMode: "graph",
      editJsonText: "[]",
      editingSteps,
      currentLegacyMetadata: undefined,
      flowInputsText: "[]",
      flowEnvVariablesText: "[]",
      testInputPresetsText: "[]",
    });

    expect(result).toEqual({
      error: expect.stringContaining('Tool step "publish"의 Tool Args JSON 파싱 실패:'),
    });
  });
});
