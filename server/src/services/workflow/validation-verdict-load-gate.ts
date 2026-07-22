import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { workflowHasConditionalEdges } from "./control-flow/edge-condition.js";
import type { ConditionalEdge } from "./control-flow/types.js";
import { normalizeWorkflowRetryPolicy } from "./retry-policy.js";

export type ValidationVerdictGateStep = {
  id: string;
  type?: string;
  name?: string;
  title?: string;
  qaType?: string;
  onFailure?: string;
  maxRetries?: number;
  dependencies?: string[];
  conditionalDependencies?: ConditionalEdge[];
};

export type ValidationVerdictGateStepRun = {
  stepId: string;
  status: string;
  issueId: string | null;
};

export function shouldLoadValidationVerdictsForRun(
  steps: ReadonlyArray<ValidationVerdictGateStep>,
  stepRuns: ReadonlyArray<ValidationVerdictGateStepRun>,
): boolean {
  if (workflowHasConditionalEdges(steps)) return true;
  const stepById = new Map(steps.map((step) => [step.id, step]));
  return stepRuns.some((stepRun) => {
    if (stepRun.status !== "failed" || !stepRun.issueId) return false;
    const step = stepById.get(stepRun.stepId);
    if (!step || !isQaLikeStep(step)) return false;
    return normalizeWorkflowRetryPolicy({
      onFailure: step.onFailure,
      maxRetries: step.maxRetries,
    }).enabled;
  });
}
