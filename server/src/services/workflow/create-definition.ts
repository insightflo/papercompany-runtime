// server/src/services/workflow/create-definition.ts
//
// [파일 목적] workflowService.createDefinition 의 생성 경로(저장 정규화 → DAG 검증 → 실행 입력
//   선언 검증 → 도구 준비 검사 → 하위 정의 순환 검사 → 저장)를 engine.ts 로부터 1:1 추출했다
//   (대형 파일 축소, 행동 불변 — 변경지도 구조 교정). engine 은 이 모듈로 위임한다.
// [수정 재사용 원문 복사] 내부 copiedStepIds 옵션이 저장 정규화까지 전달되어, 서버가 유도한
//   복사 A 단계에 새 QA rework 엣지가 합성되지 않게 한다. 공개 요청 플래그가 아니며 일반
//   생성 경로는 이 값 없이 기존 동작을 그대로 유지한다.
import type { Db } from "@paperclipai/db";
import { validateDag, type WorkflowStep } from "./dag-engine.js";
import { createWorkflowDefinition } from "./workflow-store.js";
import { normalizeWorkflowSteps } from "./normalize-definition-steps.js";
import { assertWorkflowToolReadinessForSteps } from "./admission-tool-readiness.js";
import { validateRunInputDeclarations } from "./run-input-derivations.js";
import { assertWorkflowChildDefinitionCycles } from "./workflow-child-execution.js";
import { listCompanyPlanningArtifactTools } from "../missions/mission-plan-publication-contract.js";
import type { CreateWorkflowDefinitionInput, WorkflowDefinition } from "./types.js";

/** 생성 경로 전체(정규화·검증·저장). engine.ts workflowService.createDefinition 와 동일 행동. */
export async function createWorkflowDefinitionWithNormalization(
  db: Db,
  input: CreateWorkflowDefinitionInput,
): Promise<WorkflowDefinition> {
  const steps = normalizeWorkflowSteps(input.steps as unknown[], {
    executionMode: input.executionMode,
    tools: await listCompanyPlanningArtifactTools(db, input.companyId),
    ...(input.copiedStepIds ? { copiedStepIds: input.copiedStepIds } : {}),
  });
  // Validate DAG structure
  const validation = validateDag(steps);
  if (!validation.valid) {
    throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
  }
  validateRunInputDeclarations(input.runInputs);
  await assertWorkflowToolReadinessForSteps(db, { companyId: input.companyId, steps });
  // [workflow child step] 정의 생성 시 workflow-step 타깃 체인 CYCLE DFS(자기참조 거부, diamond 허용).
  await assertWorkflowChildDefinitionCycles(db, input.companyId, null, steps);

  return createWorkflowDefinition(db, { ...input, steps });
}

export type { WorkflowStep };
