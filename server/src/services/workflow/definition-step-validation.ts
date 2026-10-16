import { unprocessable } from "../../errors.js";
import { validateWorkflowQaConfigs } from "./artifact-config-validation.js";
import {
  collectArtifactReferences,
  findWorkflowToolReferenceErrors,
  type WorkflowArtifactReferenceStep,
} from "./step-artifact-references.js";

/** Definition writes only. Never run this against workflow_run_definitions snapshots. */
export function assertWorkflowToolStepReferences(steps: readonly WorkflowArtifactReferenceStep[]): void {
  const errors = findWorkflowToolReferenceErrors(steps);
  if (!errors.length) return;
  const summary = errors.map(error => `step "${error.stepId}" references "${error.referencedStepId}" (${error.reason})`).join("; ");
  throw unprocessable(`Invalid workflow toolArgs references: ${summary}. Only known forward ancestor steps may be referenced.`, {
    code: "workflow_tool_reference_invalid", errors,
  });
}

/** [산출물 소비 하드닝 1단계] 같은 id를 가진 step이 2개 이상이면 저장 경계 전체(store 직접 호출 포함)에서 거부한다.
 * 엔진 create/update 경로는 validateDag가 이미 잡지만, 이 게이트는 store를 직접 부르는 호출까지 같은 계약으로 닫는다. */
function assertWorkflowUniqueStepIds(steps: readonly WorkflowArtifactReferenceStep[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step.id !== "string") continue;
    if (seen.has(step.id)) duplicates.add(step.id);
    else seen.add(step.id);
  }
  if (!duplicates.size) return;
  const duplicateStepIds = [...duplicates];
  throw unprocessable(`Duplicate workflow step ids: ${duplicateStepIds.join(", ")}`, {
    code: "workflow_step_duplicate_id", duplicateStepIds,
  });
}

/** Shared native/plugin/direct-store write boundary; omitted steps leave existing definitions unchanged. */
export function validateWorkflowDefinitionSteps(steps: readonly WorkflowArtifactReferenceStep[] | undefined): void {
  validateWorkflowQaConfigs(steps);
  if (!steps) return;
  assertWorkflowUniqueStepIds(steps);
  assertWorkflowToolStepReferences(steps);
}

export type WorkflowDefinitionStepWarning = {
  kind: "workproduct_selector_missing";
  stepId: string;
  referencedStepId: string;
  message: string;
};

/** selector 규칙을 붙일 수 있는 정의 step — 저장 시점 구조 검사용 느슨한 모양. */
export type WorkflowSelectorAwareStep = WorkflowArtifactReferenceStep & { workProductSelectors?: unknown };

/** [산출물 소비 하드닝 1단계] 규칙(workProductSelectors) 없는 타-단계 산출물 참조 경고(warn-only).
 * 대상은 게이트가 이미 422로 거부하는 unknown/not_ancestor 참조가 아닌 known+ancestor 참조뿐이다.
 * seed(workflowRunSeeds)로 공급되는 참조는 정의 시점에 알 수 없어 오탐될 수 있다 — 문구로 안내한다. */
export function findWorkflowDefinitionStepWarnings(steps: readonly WorkflowSelectorAwareStep[]): WorkflowDefinitionStepWarning[] {
  const rejected = new Set(findWorkflowToolReferenceErrors(steps).map(error => `${error.stepId}\0${error.referencedStepId}`));
  const warnings: WorkflowDefinitionStepWarning[] = [];
  for (const step of steps) {
    const references = [...collectArtifactReferences(step.toolArgs)].sort();
    if (!references.length) continue;
    const selectors = step.workProductSelectors && typeof step.workProductSelectors === "object"
      ? step.workProductSelectors as Record<string, unknown>
      : {};
    for (const referencedStepId of references) {
      if (rejected.has(`${step.id}\0${referencedStepId}`)) continue;
      if (referencedStepId in selectors) continue;
      warnings.push({
        kind: "workproduct_selector_missing",
        stepId: step.id,
        referencedStepId,
        message: `Step "${step.id}" consumes the work product of ancestor step "${referencedStepId}" through a {$steps.${referencedStepId}.workProduct*} token but declares no workProductSelectors rule for it. `
          + `Without a rule the runtime falls back to a representative-first, latest-first pick and can permanently pin an arbitrary artifact (for example an image instead of content.json), which later fails consumption with qa_artifact_consumer_input_mismatch. `
          + `Fix by adding to step "${step.id}": "workProductSelectors": { "${referencedStepId}": { "type": "<work product type>", "title": "<exact registered work product title>" } } — read the exact type and title from the artifacts registered by producing step "${referencedStepId}". `
          + `References supplied by a runtime seed (workflowRunSeeds) are exempt from this warning and need no selector.`,
      });
    }
  }
  return warnings;
}

/** 감사(activity log) 요약 — 전체 문구는 logger.warn 구조화 로그로 남긴다. */
export function summarizeDefinitionStepWarnings(warnings: readonly WorkflowDefinitionStepWarning[]) {
  return warnings.map(({ kind, stepId, referencedStepId }) => ({ kind, stepId, referencedStepId }));
}
