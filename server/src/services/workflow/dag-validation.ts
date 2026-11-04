import type { WorkflowStep } from "./dag-engine.js";
import type { DagValidationResult } from "./types.js";
import { hasDisallowedCycle } from "./control-flow/cycle-validator.js";
import { validateWorkflowControlNodes } from "./control-flow/control-node-validation.js";

export function validateDag(steps: WorkflowStep[]): DagValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));

  // Check for duplicate step IDs
  if (stepIds.size !== steps.length) {
    errors.push("Duplicate step IDs detected");
  }

  // Check for orphan dependencies (legacy dependencies[] + conditionalDependencies edge.stepId)
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${dep}"`);
      }
    }
    // [IF/loop] conditional edge 의 선행 stepId 도 orphan 검사 — 빠지면 해당 step 이 영원히 waiting 에
    // 갇혀 run 이 terminal 에 수렴하지 못 한다(가즈아 60min reconciler kill 회귀).
    for (const edge of step.conditionalDependencies ?? []) {
      if (!stepIds.has(edge.stepId)) {
        errors.push(`Step "${step.id}" conditionalDependency references non-existent step "${edge.stepId}"`);
      }
    }
  }

  // Native IF/Complete nodes have stricter semantic topology than ordinary DAG
  // steps. Validate it at the shared create/update/launch boundary so malformed
  // branches cannot be persisted or executed.
  errors.push(...validateWorkflowControlNodes(steps));

  // Check for cycles: annotated back-edge(isBackEdge+maxIterations≥1) 로 닫히는 cycle(bounded loop)은 허용,
  // 그 외 우연한 cycle 은 거부(control-flow/cycle-validator).
  const hasCycle = hasDisallowedCycle(steps);
  if (hasCycle) {
    errors.push("Workflow contains an unannotated cycle (circular dependency); only annotated back-edges (isBackEdge + maxIterations) may form a bounded loop");
  }

  // Check for steps with no dependencies (entry points)
  const entryPoints = steps.filter((s) => s.dependencies.length === 0);
  if (entryPoints.length === 0 && steps.length > 0) {
    errors.push("Workflow has no entry points (all steps have dependencies)");
  }

  // Check for unreachable steps
  if (entryPoints.length > 0) {
    const reachable = new Set<string>();
    for (const entry of entryPoints) {
      dfsReachable(entry, steps, reachable);
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) {
        warnings.push(`Step "${step.id}" is unreachable from any entry point`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Marks all steps reachable from the given step.
 */
function dfsReachable(step: WorkflowStep, allSteps: WorkflowStep[], visited: Set<string>): void {
  if (visited.has(step.id)) return;
  visited.add(step.id);

  for (const depId of step.dependencies) {
    const dep = allSteps.find((s) => s.id === depId);
    if (dep) {
      dfsReachable(dep, allSteps, visited);
    }
  }
}
