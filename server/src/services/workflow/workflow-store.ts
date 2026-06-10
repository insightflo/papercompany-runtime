/**
 * Workflow Store
 *
 * Database access layer for workflow definitions and runs.
 * Replaces PluginContext.entities with direct Drizzle ORM queries.
 */

import type { Db } from "@paperclipai/db";
import { workflowDefinitions, workflowRuns, workflowStepRuns, issues } from "@paperclipai/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowStepExecutionContract,
} from "./types.js";
import type { CreateWorkflowDefinitionInput, CreateWorkflowRunInput } from "./types.js";
import { isDynamicOwnerPlanWorkflowDefinition, normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";

function inferWorkflowExecutionMode(name: string, steps: WorkflowStep[]): WorkflowExecutionMode {
  return isDynamicOwnerPlanWorkflowDefinition({ name, steps }) ? "dynamic_owner_plan" : "static_dag";
}

/**
 * Create a new workflow definition.
 */
export async function createWorkflowDefinition(
  db: Db,
  input: CreateWorkflowDefinitionInput,
): Promise<WorkflowDefinition> {
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(workflowDefinitions).values({
    id,
    companyId: input.companyId,
    name: input.name,
    stepsJson: input.steps,
    createdAt: now,
    updatedAt: now,
  });

  return getWorkflowDefinitionById(db, id) as Promise<WorkflowDefinition>;
}

/**
 * Get a workflow definition by ID.
 */
export async function getWorkflowDefinitionById(
  db: Db,
  id: string,
): Promise<WorkflowDefinition | null> {
  const result = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .limit(1);

  if (!result[0]) return null;

  const def = result[0];
  const steps = normalizeWorkflowStepsForExecution(def.stepsJson);
  return {
    id: def.id,
    companyId: def.companyId,
    name: def.name,
    steps,
    executionMode: inferWorkflowExecutionMode(def.name, steps),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

/**
 * List workflow definitions for a company.
 */
export async function listWorkflowDefinitions(
  db: Db,
  companyId: string,
): Promise<WorkflowDefinition[]> {
  const results = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.companyId, companyId))
    .orderBy(desc(workflowDefinitions.createdAt));

  return results.map((def) => {
    const steps = normalizeWorkflowStepsForExecution(def.stepsJson);
    return {
      id: def.id,
      companyId: def.companyId,
      name: def.name,
      steps,
      executionMode: inferWorkflowExecutionMode(def.name, steps),
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  });
}

/**
 * Update a workflow definition.
 */
export async function updateWorkflowDefinition(
  db: Db,
  id: string,
  updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">>,
): Promise<WorkflowDefinition | null> {
  const { steps, executionMode: _executionMode, ...definitionUpdates } = updates;
  await db
    .update(workflowDefinitions)
    .set({
      ...definitionUpdates,
      ...(steps ? { stepsJson: steps } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workflowDefinitions.id, id));

  return getWorkflowDefinitionById(db, id);
}

/**
 * Delete a workflow definition.
 */
export async function deleteWorkflowDefinition(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id))
    .returning({ id: workflowDefinitions.id });

  return rows.length > 0;
}

/**
 * Create a new workflow run.
 */
export async function createWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
): Promise<WorkflowRun> {
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(workflowRuns).values({
    id,
    workflowId: input.workflowId,
    companyId: input.companyId,
    missionId: input.missionId ?? null,
    status: "pending",
    triggeredBy: input.triggeredBy,
    createdAt: now,
  });

  return getWorkflowRunById(db, id) as Promise<WorkflowRun>;
}

/**
 * Get a workflow run by ID.
 */
export async function getWorkflowRunById(
  db: Db,
  id: string,
): Promise<WorkflowRun | null> {
  const result = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, id))
    .limit(1);

  if (!result[0]) return null;
  return result[0] as WorkflowRun;
}

/**
 * List workflow runs for a company or workflow.
 */
export async function listWorkflowRuns(
  db: Db,
  filters: { companyId?: string; workflowId?: string; missionId?: string },
): Promise<WorkflowRun[]> {
  const conditions = [];
  if (filters.companyId) conditions.push(eq(workflowRuns.companyId, filters.companyId));
  if (filters.workflowId) conditions.push(eq(workflowRuns.workflowId, filters.workflowId));
  if (filters.missionId) conditions.push(eq(workflowRuns.missionId, filters.missionId));

  const results = await db
    .select()
    .from(workflowRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(workflowRuns.createdAt));
  return results as WorkflowRun[];
}

/**
 * List workflow step runs for a workflow run.
 */
export async function listWorkflowStepRuns(
  db: Db,
  workflowRunId: string,
): Promise<WorkflowStepRun[]> {
  const results = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId));

  return results.map((sr) => ({
    id: sr.id,
    workflowRunId: sr.workflowRunId,
    stepId: sr.stepId,
    issueId: sr.issueId,
    status: sr.status as "pending" | "running" | "completed" | "failed" | "skipped",
    startedAt: sr.startedAt,
    completedAt: sr.completedAt,
  }));
}

export async function getWorkflowStepExecutionContractForIssue(
  db: Db,
  issueId: string,
): Promise<WorkflowStepExecutionContract | null> {
  const result = await db
    .select({
      stepRun: workflowStepRuns,
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowStepRuns.issueId, issueId))
    .limit(1);

  const row = result[0];
  if (!row) return null;

  const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
  const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  const rawStep = step as (WorkflowStep & { agentName?: unknown; type?: unknown }) | undefined;
  const stepType = typeof rawStep?.type === "string" ? rawStep.type.trim().toLowerCase() : "";
  const agentName = typeof rawStep?.agentName === "string" ? rawStep.agentName.trim() : "";
  const isAgentBackedStep = stepType === "agent" || agentName.length > 0;
  const toolNames = !isAgentBackedStep && Array.isArray(step?.toolNames)
    ? step.toolNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return {
    workflowRunId: row.run.id,
    workflowId: row.run.workflowId,
    missionId: row.run.missionId,
    stepId: row.stepRun.stepId,
    stepName: step?.name ?? row.stepRun.stepId,
    toolNames,
    knowledgeBaseIds: Array.isArray(step?.knowledgeBaseIds)
      ? step.knowledgeBaseIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
  };
}

/**
 * Update workflow run status.
 */
export async function updateWorkflowRunStatus(
  db: Db,
  id: string,
  status: WorkflowRun["status"],
): Promise<void> {
  const updates: Partial<WorkflowRun> = { status };
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updates.completedAt = new Date();
  }
  if (status === "running" && !updates.startedAt) {
    updates.startedAt = new Date();
  }

  await db
    .update(workflowRuns)
    .set(updates)
    .where(eq(workflowRuns.id, id));
}

/**
 * Resume a workflow run through the native server DAG engine.
 */
export async function resumeWorkflowRun(
  db: Db,
  id: string,
  companyId: string,
): Promise<WorkflowRun | null> {
  const [run] = await db
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    })
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.companyId, companyId)))
    .returning();

  return (run as WorkflowRun | undefined) ?? null;
}

/**
 * Cancel a workflow run.
 */
export async function cancelWorkflowRun(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(eq(workflowRuns.id, id))
    .returning({ id: workflowRuns.id });

  return rows.length > 0;
}
