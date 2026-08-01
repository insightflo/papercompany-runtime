import { workflowStepRuns } from "@paperclipai/db";
import type { PredFacts, PredStatus } from "./control-flow/edge-condition.js";
import type { WorkflowStep } from "./dag-engine.js";

export function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, (typeof workflowStepRuns.$inferSelect)> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

export function buildPredFactsMap(
  steps: WorkflowStep[],
  stepRunMap: Map<string, (typeof workflowStepRuns.$inferSelect)>,
  _validationVerdicts?: unknown,
  v1EnforcementEnabled?: boolean,
): Map<string, PredFacts> {
  const facts = new Map<string, PredFacts>();
  for (const step of steps) {
    const run = stepRunMap.get(step.id);
    facts.set(step.id, {
      status: (run?.status ?? "pending") as PredStatus,
      isQaGate: false,
      verdict: null,
      verdictChecked: false,
      ...(v1EnforcementEnabled ? { dispatchReady: run?.dispatchReadyAt != null } : {}),
    });
  }
  return facts;
}
