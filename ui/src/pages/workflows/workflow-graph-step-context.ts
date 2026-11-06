// Resolves a single step's context (dependencies, dependents, neighbours) for the graph UI.
// Split out of workflow-graph.ts (pure move, function body unchanged).

import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphStepContext } from "./workflow-graph-types-interface.js";
import { parseDependencies } from "./workflow-graph-dependencies.js";
import { buildStepMap } from "./workflow-graph-step-runtime.js";

export function getWorkflowGraphStepContext<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): WorkflowGraphStepContext {
  const id = stepId.trim();
  const stepMap = buildStepMap(steps);
  const orderedStepIds = steps.map((step) => step.id.trim()).filter(Boolean);
  const selectedStep = id ? stepMap.get(id) : undefined;
  const directDependencyCandidates = selectedStep ? parseDependencies(selectedStep.dependsOn) : [];
  const directDependencyIds = Array.from(new Set(directDependencyCandidates.filter((dependencyId) => stepMap.has(dependencyId))));
  const missingDependencyIds = Array.from(new Set(directDependencyCandidates.filter((dependencyId) => !stepMap.has(dependencyId))));
  const directDependentIds = orderedStepIds.filter((candidateId) => {
    const candidateStep = stepMap.get(candidateId);
    return Boolean(candidateStep && parseDependencies(candidateStep.dependsOn).includes(id));
  });

  const upstreamSet = new Set<string>();
  const downstreamSet = new Set<string>();

  function collectUpstream(currentId: string, visiting = new Set<string>()): void {
    if (visiting.has(currentId)) return;
    visiting.add(currentId);
    const currentStep = stepMap.get(currentId);
    if (!currentStep) return;
    for (const dependencyId of parseDependencies(currentStep.dependsOn)) {
      if (!stepMap.has(dependencyId)) continue;
      upstreamSet.add(dependencyId);
      collectUpstream(dependencyId, visiting);
    }
  }

  function collectDownstream(currentId: string, visiting = new Set<string>()): void {
    if (visiting.has(currentId)) return;
    visiting.add(currentId);
    for (const candidateId of orderedStepIds) {
      const candidateStep = stepMap.get(candidateId);
      if (!candidateStep || !parseDependencies(candidateStep.dependsOn).includes(currentId)) continue;
      downstreamSet.add(candidateId);
      collectDownstream(candidateId, visiting);
    }
  }

  if (id && stepMap.has(id)) {
    collectUpstream(id);
    collectDownstream(id);
  }

  return {
    stepId: id,
    directDependencyIds,
    directDependentIds,
    upstreamStepIds: orderedStepIds.filter((candidateId) => candidateId !== id && upstreamSet.has(candidateId)),
    downstreamStepIds: orderedStepIds.filter((candidateId) => candidateId !== id && downstreamSet.has(candidateId)),
    missingDependencyIds,
  };
}
