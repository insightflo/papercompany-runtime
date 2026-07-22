// @vitest-environment node

import { describe, expect, it } from "vitest";
import { jsonToSteps } from "./step-draft.js";
import { buildWorkflowDefinitionEditPatch } from "./workflow-definition-edit-patch.js";

function buildPatch(editingSteps = jsonToSteps([])) {
  return buildWorkflowDefinitionEditPatch({
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
}

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

    const result = buildPatch(editingSteps);

    expect(result).toEqual({
      error: expect.stringContaining('Tool step "publish"의 Tool Args JSON 파싱 실패:'),
    });
  });

  it("serializes retryDelaySeconds zero from StepDraft into workflow JSON", () => {
    const editingSteps = jsonToSteps([{
      id: "publish",
      title: "Publish report",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
      onFailure: "retry",
      graphRetryDelaySeconds: 0,
    }]);

    const result = buildPatch(editingSteps);

    expect(result).toEqual({
      patch: expect.objectContaining({
        steps: [expect.objectContaining({ onFailure: "retry", graphRetryDelaySeconds: 0 })],
      }),
    });
  });

  it("preserves saved retry values when retry policy is inactive", () => {
    const editingSteps = jsonToSteps([{
      id: "publish",
      title: "Publish report",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
      onFailure: "skip",
      maxRetries: 4,
      graphRetryDelaySeconds: 0,
      graphRetryBackoff: "linear",
      graphRetryJitter: true,
    }]);

    const result = buildPatch(editingSteps);

    expect(result).toEqual({
      patch: expect.objectContaining({
        steps: [expect.objectContaining({
          onFailure: "skip",
          maxRetries: 4,
          graphRetryDelaySeconds: 0,
          graphRetryBackoff: "linear",
          graphRetryJitter: true,
        })],
      }),
    });
  });
});
