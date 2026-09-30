import type { workflowDefinitions } from "@paperclipai/db";
import { buildWorkflowExecutionSteps, isDynamicOwnerPlanWorkflowDefinition } from "./execution-steps.js";
import { buildExecutionDefinitionPayload, hashExecutionDefinitionPayload } from "./execution-definition-codec.js";

export function replacementDefinitionHash(definition: typeof workflowDefinitions.$inferSelect, missionId: string, targetRunId: string) {
  const steps = buildWorkflowExecutionSteps({ name: definition.name, stepsJson: definition.stepsJson,
    executionMode: definition.executionMode, dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly });
  const executionMode = isDynamicOwnerPlanWorkflowDefinition({ ...definition, steps }) ? "dynamic_owner_plan" : "static_dag";
  return hashExecutionDefinitionPayload(buildExecutionDefinitionPayload({ companyId: definition.companyId, workflowRunId: targetRunId,
    executionMode, steps: JSON.parse(JSON.stringify(steps)), provenance: { schemaVersion: 1, origin: "run_creation",
      workflowId: definition.id, missionId, workflowName: definition.name, source: definition.source ?? null,
      sourceKind: definition.sourceKind ?? null, definitionUpdatedAt: definition.updatedAt.toISOString() } }));
}
