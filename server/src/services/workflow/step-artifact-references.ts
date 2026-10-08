import type { ConditionalEdge } from "./control-flow/types.js";

export type WorkflowArtifactReferenceStep = {
  id: string;
  dependencies?: readonly string[];
  dependsOn?: readonly string[];
  conditionalDependencies?: readonly ConditionalEdge[];
  toolArgs?: unknown;
};

export const STEP_ARTIFACT_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;

/** Scan only structural tool argument tokens, never agent prose or output. */
export function collectArtifactReferences(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_ARTIFACT_TOKEN)) {
      if (match[1]) result.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectArtifactReferences(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectArtifactReferences(item, result);
  }
  return result;
}

/** All forward predecessors are structural ancestors, regardless of their activation condition.
 * This includes success/failure/always/QA/IF edges (omitted when means success).
 * Back edges point to later steps, not input producers. Ancestry does not prove execution.
 */
export function collectAncestorStepIds(currentStepId: string, steps: readonly WorkflowArtifactReferenceStep[]): Set<string> {
  const byId = new Map(steps.map(step => [step.id, step]));
  const visited = new Set([currentStepId]);
  const ancestors = new Set<string>();
  const stack = [currentStepId];
  while (stack.length) {
    const step = byId.get(stack.pop()!);
    if (!step) continue;
    const predecessors = [
      ...(step.dependencies ?? step.dependsOn ?? []),
      ...(step.conditionalDependencies ?? []).filter(edge => edge.isBackEdge !== true).map(edge => edge.stepId),
    ];
    for (const id of predecessors) {
      if (visited.has(id)) continue;
      visited.add(id);
      ancestors.add(id);
      stack.push(id);
    }
  }
  return ancestors;
}

export type WorkflowToolReferenceError = {
  stepId: string;
  referencedStepId: string;
  reason: "unknown_step" | "not_ancestor";
};

/** Pure definition validation: ancestry is structural, not proof of execution. */
export function findWorkflowToolReferenceErrors(steps: readonly WorkflowArtifactReferenceStep[]): WorkflowToolReferenceError[] {
  const knownIds = new Set(steps.map(step => step.id));
  const errors: WorkflowToolReferenceError[] = [];
  for (const step of steps) {
    const references = collectArtifactReferences(step.toolArgs);
    if (!references.size) continue;
    const ancestors = collectAncestorStepIds(step.id, steps);
    for (const referencedStepId of references) {
      if (!knownIds.has(referencedStepId)) {
        errors.push({ stepId: step.id, referencedStepId, reason: "unknown_step" });
      } else if (!ancestors.has(referencedStepId)) {
        errors.push({ stepId: step.id, referencedStepId, reason: "not_ancestor" });
      }
    }
  }
  return errors;
}
