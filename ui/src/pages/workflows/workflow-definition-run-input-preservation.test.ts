// @vitest-environment node

import { expect, it } from "vitest";
import { jsonToSteps } from "./step-draft.js";
import { buildWorkflowDefinitionEditPatch } from "./workflow-definition-edit-patch.js";

// [목적] Task 6C.2 보존(characterization) 테스트: Flow inputs 편집 PATCH는 runInputs를
// 건드리지 않는다(own key 부재). DB 쪽 부분 패치 보존 증거는 서버 통합 테스트
// workflow-run-input-http.integration.test.ts의 engine/HTTP PATCH round trip과 짝을 이룬다.
// [care] Flow inputs(legacyMetadata.graphFlowInputs)와 runInputs(정의 JSONB)는 다른 개념이다.
it("editing Flow inputs omits runInputs from the PATCH", () => {
  const result = buildWorkflowDefinitionEditPatch({
    name: "Onboarding",
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
    editingSteps: jsonToSteps([]),
    currentLegacyMetadata: { unrelated: "keep" },
    flowInputsText: '[{"key":"topic"}]',
    flowEnvVariablesText: "[]",
    testInputPresetsText: "[]",
  });
  expect("patch" in result).toBe(true);
  if (!("patch" in result)) throw new Error(result.error);
  expect(result.patch).not.toHaveProperty("runInputs");
  expect(result.patch.legacyMetadata).toMatchObject({
    unrelated: "keep",
    graphFlowInputs: [{ key: "topic" }],
  });
  // Flow inputs의 실제 저장 키는 legacyMetadata.graphFlowInputs다(flowInputs 아님).
  expect(result.patch.legacyMetadata).not.toHaveProperty("flowInputs");
  // 패치는 여전히 전체 스텝 배열을 실어 보내는 기존 계약을 유지한다.
  expect(result.patch).toHaveProperty("steps");
});
