// Generic structural-gate dependency topology checks.

import { isQaLikeStep } from "../../missions/supervision-helpers.js";
import { isStructuralGateStep } from "./structural-gate.js";

export interface StructuralTopologyStep {
  id: string;
  dependencies: string[];
  name?: string;
  title?: string;
  type?: string;
  qaType?: string;
  agentId?: string;
  toolNames?: string[];
}

/** Structural gates validate one producer. A semantic QA that reviews that
 * producer must name both the producer artifact and every related gate. */
export function getStructuralTopologyErrors(steps: StructuralTopologyStep[]): string[] {
  const errors: string[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const gates = steps.filter(isStructuralGateStep);
  if (gates.length === 0) return errors;

  for (const gate of gates) {
    const producers = gate.dependencies
      .map((id) => byId.get(id))
      .filter((step): step is StructuralTopologyStep => Boolean(step) && !isStructuralGateStep(step));
    if (producers.length !== 1) {
      errors.push(`Structural gate "${gate.id}" must have exactly one non-gate producer dependency, got ${producers.length}.`);
    }
  }

  for (const qa of steps) {
    if (isStructuralGateStep(qa) || !isQaLikeStep(qa)) continue;
    for (const dependencyId of qa.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      if (isStructuralGateStep(dependency)) {
        const producers = dependency.dependencies
          .map((id) => byId.get(id))
          .filter((step): step is StructuralTopologyStep => Boolean(step) && !isStructuralGateStep(step));
        for (const producer of producers) {
          if (!qa.dependencies.includes(producer.id)) {
            errors.push(`QA step "${qa.id}" depends on structural gate "${dependency.id}" but omits producer "${producer.id}".`);
          }
        }
        continue;
      }
      const gatesForProducer = gates.filter((gate) => gate.dependencies.includes(dependency.id));
      const missing = gatesForProducer.filter((gate) => !qa.dependencies.includes(gate.id));
      if (missing.length > 0) {
        errors.push(`QA step "${qa.id}" reviews producer "${dependency.id}" but is missing structural gate(s): ${missing.map((gate) => gate.id).join(", ")}.`);
      }
    }
  }
  return errors;
}
