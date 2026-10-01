import { revisionStepHash, type RevisionStep } from "./revision-step-config.js";

/** Identity-free executable DAG fingerprints. Only typed forward edges and native reference
 * tokens participate; titles, mission-derived IDs and prose never establish correspondence.
 * This is comparison only: it never grants cross-run reuse or invents a sourceStepId.
 */
export function revisionGraphHashes(steps: RevisionStep[]) {
  const byId = new Map(steps.map(step => [step.id, step]));
  const hashes = new Map<string, string>();
  const visiting = new Set<string>();
  const hash = (id: string): string => {
    const cached = hashes.get(id);
    if (cached) return cached;
    const step = byId.get(id);
    if (!step || visiting.has(id)) throw new Error("mission_revision_invalid_execution_graph");
    visiting.add(id);
    for (const dependency of step.dependencies) hash(dependency);
    for (const edge of step.conditionalDependencies ?? []) if (!edge.isBackEdge) hash(edge.stepId);
    const coordinates = steps.map(s => ({ ...s, sourceStepId: hashes.get(s.id) ?? s.id }));
    const value = revisionStepHash(step, coordinates, "failure");
    hashes.set(id, value);
    visiting.delete(id);
    return value;
  };
  for (const step of steps) hash(step.id);
  return hashes;
}
