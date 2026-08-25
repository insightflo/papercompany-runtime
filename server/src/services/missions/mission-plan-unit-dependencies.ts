import { normalizeMissionPlanDependencyGraph } from "./mission-plan-dependency-graph.js";

/** Uses the shared fail-closed normalizer so PLAN-QA sees materializer-identical adjacency. */
export function buildDependencyIndex(selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>): number[][] {
  const normalized = normalizeMissionPlanDependencyGraph(selectedExecutionUnits);
  if (!normalized.ok) {
    throw new Error(`Invalid canonical mission-plan dependency graph: ${normalized.diagnostics.map((entry) => entry.message).join("; ")}`);
  }
  return normalized.graph.dependencyIndex;
}

export function unitDependsOn(dependencyIndex: number[][], fromIndex: number, targetIndex: number): boolean {
  const visited = new Set<number>();
  const stack = [...(dependencyIndex[fromIndex] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) return false;
    if (current === targetIndex) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(dependencyIndex[current] ?? []));
  }
  return false;
}
