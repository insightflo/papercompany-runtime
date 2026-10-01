import { and, eq, inArray } from 'drizzle-orm';
import { toolDefinitions, type Db } from '@paperclipai/db';
import { buildWorkflowExecutionSteps, normalizeWorkflowStepsForExecution, type WorkflowDefinitionExecutionInput } from './execution-steps.js';

/** Resolve declarations at capture time only; callers must not rebuild frozen run steps. */
export async function buildCompanyWorkflowExecutionSteps(
  db: Pick<Db, 'select'>,
  definition: WorkflowDefinitionExecutionInput & { companyId: string },
) {
  const names = [...new Set(normalizeWorkflowStepsForExecution(definition.stepsJson).flatMap(step => step.toolNames ?? []))];
  const tools = names.length ? await db.select({ name: toolDefinitions.name, adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions).where(and(eq(toolDefinitions.companyId, definition.companyId), inArray(toolDefinitions.name, names))) : [];
  return buildWorkflowExecutionSteps(definition, tools);
}
