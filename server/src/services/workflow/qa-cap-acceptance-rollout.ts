import type { Db } from "@paperclipai/db";
import { isQaLikeStep } from "../workflow-step-role.js";
import { isDeliveryReadbackStep } from "./delivery-verification-gate.js";
import { workflowService } from "./engine.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import type { WorkflowStep } from "./dag-engine.js";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "succeeded",
  "done",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "aborted",
]);

export type QaCapAcceptanceRolloutResult = {
  inspectedWorkflows: number;
  updatedWorkflows: number;
  updatedQaEdges: number;
  skippedActiveWorkflows: number;
};

export function enableQaCapAcceptanceInSteps(steps: WorkflowStep[]): {
  steps: WorkflowStep[];
  updatedQaEdges: number;
} {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  let updatedQaEdges = 0;

  const nextSteps = steps.map((producer) => {
    if (!producer.conditionalDependencies?.length) return producer;
    let producerChanged = false;
    const conditionalDependencies = producer.conditionalDependencies.map((edge) => {
      const qaStep = stepById.get(edge.stepId);
      const eligible = edge.when === "qa_request_changes"
        && edge.isBackEdge === true
        && typeof edge.maxIterations === "number"
        && edge.maxIterations >= 1
        && Boolean(qaStep)
        && isQaLikeStep(qaStep!)
        && !isStructuralGateStep(qaStep!)
        && !isDeliveryReadbackStep(qaStep!);
      if (!eligible || edge.allowCapAcceptance === true) return edge;
      producerChanged = true;
      updatedQaEdges += 1;
      return { ...edge, allowCapAcceptance: true };
    });
    return producerChanged ? { ...producer, conditionalDependencies } : producer;
  });

  return { steps: updatedQaEdges > 0 ? nextSteps : steps, updatedQaEdges };
}

export async function enableQaCapAcceptanceForCompany(db: Db, companyId: string): Promise<QaCapAcceptanceRolloutResult> {
  const [definitions, runs] = await Promise.all([
    workflowService.listDefinitions(db, companyId),
    workflowService.listRuns(db, { companyId }),
  ]);
  const activeDefinitions = definitions.filter((definition) => definition.status === "active");
  const workflowIdsWithActiveRuns = new Set(
    runs
      .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status.trim().toLowerCase()))
      .map((run) => run.workflowId),
  );

  let updatedWorkflows = 0;
  let updatedQaEdges = 0;
  let skippedActiveWorkflows = 0;
  for (const definition of activeDefinitions) {
    if (workflowIdsWithActiveRuns.has(definition.id)) {
      skippedActiveWorkflows += 1;
      continue;
    }
    const update = enableQaCapAcceptanceInSteps(definition.steps);
    if (update.updatedQaEdges === 0) continue;
    await workflowService.updateDefinition(db, definition.id, { steps: update.steps });
    updatedWorkflows += 1;
    updatedQaEdges += update.updatedQaEdges;
  }

  return {
    inspectedWorkflows: activeDefinitions.length,
    updatedWorkflows,
    updatedQaEdges,
    skippedActiveWorkflows,
  };
}
