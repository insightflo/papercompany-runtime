import type { WorkflowStep } from "./dag-engine.js";
import { normalizeWorkflowStepsForExecution } from "./execution-steps.js";
import { validateWorkflowQaConfigs } from "./artifact-config-validation.js";
import { assertWorkflowToolStepReferences } from "./definition-step-validation.js";
import { isQaLikeStep, synthesizeQaReworkBackEdge } from "../missions/supervision-helpers.js";
import type { PlanningArtifactTool } from "../missions/mission-plan-publication-contract.js";

type WorkflowStepLike = WorkflowStep & {
  title?: unknown; dependsOn?: unknown; tools?: unknown; toolName?: unknown; agentName?: unknown;
};

/** Save-time normalization only: never rebuild an already captured run definition. */
export function normalizeWorkflowSteps(
  steps: unknown[],
  options: { executionMode?: unknown; dynamicPlanBootstrapOnly?: unknown; tools?: readonly PlanningArtifactTool[];
    /** [수정 재사용] 서버 유도 복사 A 단계 ID — 저장 시점 QA rework 합성이 새 엣지를 A 에 추가하지 않는다. 내부 옵션. */
    copiedStepIds?: ReadonlySet<string> } = {},
): WorkflowStep[] {
  validateWorkflowQaConfigs(steps);
  const normalizedSteps = steps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as WorkflowStepLike;
    const { conditionalDependencies: _rawConditionalDependencies, ...stepWithoutRawConditionalDependencies } = step;
    const normalized = normalizeWorkflowStepsForExecution([step])[0]!;
    const toolNames = normalized.toolNames;
    return {
      ...stepWithoutRawConditionalDependencies,
      id: normalized.id,
      name: normalized.name,
      agentId: normalized.agentId,
      dependencies: normalized.dependencies,
      graphWorkProductRequired: normalized.graphWorkProductRequired,
      ...(normalized.conditionalDependencies ? { conditionalDependencies: normalized.conditionalDependencies } : {}),
      ...(toolNames ? { toolNames } : {}),
    };
  });
  assertWorkflowToolStepReferences(normalizedSteps);
  const dynamicOwnerPlan = options.executionMode === "dynamic_owner_plan"
    || options.dynamicPlanBootstrapOnly === true
    || options.dynamicPlanBootstrapOnly === "true";
  const stepsWithQaLoops = normalizedSteps
    .filter((step) => isQaLikeStep(step) && step.dependencies.length > 0)
    .reduce((nextSteps, qaStep) => synthesizeQaReworkBackEdge(nextSteps, qaStep.id, undefined,
      { tools: options.tools, copiedStepIds: options.copiedStepIds }), normalizedSteps);
  if (!dynamicOwnerPlan) return stepsWithQaLoops;
  return stepsWithQaLoops.map((step) => {
    if (step.triggerOn === "escalation" || step.dependencies.length > 0) return step;
    return {
      ...step,
      dynamicChildren: step.dynamicChildren ?? true,
      ownerPlanBootstrapOnly: step.ownerPlanBootstrapOnly ?? true,
      executionMode: step.executionMode ?? "dynamic_owner_plan",
    };
  });
}
