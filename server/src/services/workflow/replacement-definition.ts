import type { workflowDefinitions, Db } from "@paperclipai/db";
import { isDynamicOwnerPlanWorkflowDefinition } from "./execution-steps.js";
import { buildCompanyWorkflowExecutionSteps } from './company-execution-steps.js';
import { buildExecutionDefinitionPayload, hashExecutionDefinitionPayload } from "./execution-definition-codec.js";

export async function replacementDefinitionHash(db: Pick<Db, 'select'>, definition: typeof workflowDefinitions.$inferSelect, missionId: string, targetRunId: string) {
  const steps = await buildCompanyWorkflowExecutionSteps(db, definition);
  const executionMode = isDynamicOwnerPlanWorkflowDefinition({ ...definition, steps }) ? "dynamic_owner_plan" : "static_dag";
  return hashExecutionDefinitionPayload(buildExecutionDefinitionPayload({ companyId: definition.companyId, workflowRunId: targetRunId,
    executionMode, steps: JSON.parse(JSON.stringify(steps)), provenance: { schemaVersion: 1, origin: "run_creation",
      workflowId: definition.id, missionId, workflowName: definition.name, source: definition.source ?? null,
      sourceKind: definition.sourceKind ?? null, definitionUpdatedAt: definition.updatedAt.toISOString() } }));
}
