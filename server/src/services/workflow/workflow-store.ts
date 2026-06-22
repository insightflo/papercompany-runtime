/**
 * Workflow Store
 *
 * Database access layer for workflow definitions and runs.
 * Replaces PluginContext.entities with direct Drizzle ORM queries.
 */

import type { Db } from "@paperclipai/db";
import { workflowDefinitions, workflowRunSlots, workflowRuns, workflowStepRuns, issues } from "@paperclipai/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunSlot,
  WorkflowStepRun,
  WorkflowStepExecutionContract,
} from "./types.js";
import type { CreateWorkflowDefinitionInput, CreateWorkflowRunInput } from "./types.js";
import { isDynamicOwnerPlanWorkflowDefinition, normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";

function inferWorkflowExecutionMode(name: string, steps: WorkflowStep[]): WorkflowExecutionMode {
  return isDynamicOwnerPlanWorkflowDefinition({ name, steps }) ? "dynamic_owner_plan" : "static_dag";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapWorkflowDefinition(def: typeof workflowDefinitions.$inferSelect): WorkflowDefinition {
  const steps = normalizeWorkflowStepsForExecution(def.stepsJson);
  return {
    id: def.id,
    companyId: def.companyId,
    name: def.name,
    description: def.description,
    status: def.status,
    steps,
    schedule: def.schedule,
    timezone: def.timezone,
    deadlineTime: def.deadlineTime,
    lastScheduledRunAt: def.lastScheduledRunAt,
    lastScheduleError: def.lastScheduleError,
    lastScheduleErrorAt: def.lastScheduleErrorAt,
    timeoutMinutes: def.timeoutMinutes,
    maxDailyRuns: def.maxDailyRuns,
    maxConcurrentRuns: def.maxConcurrentRuns,
    triggerLabels: normalizeStringArray(def.triggerLabels),
    labelIds: normalizeStringArray(def.labelIds),
    projectId: def.projectId,
    goalId: def.goalId,
    createParentIssuePolicy: def.createParentIssuePolicy,
    executionMode: def.executionMode ?? inferWorkflowExecutionMode(def.name, steps),
    dynamicPlanBootstrapOnly: def.dynamicPlanBootstrapOnly,
    source: def.source ?? "native",
    sourceKind: def.sourceKind ?? "workflow",
    legacyPluginEntityId: def.legacyPluginEntityId,
    legacyMetadata: normalizeMetadata(def.legacyMetadata),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

function mapWorkflowRun(run: typeof workflowRuns.$inferSelect): WorkflowRun {
  return {
    id: run.id,
    workflowId: run.workflowId,
    companyId: run.companyId,
    missionId: run.missionId,
    status: run.status,
    originalStatus: run.originalStatus,
    triggeredBy: run.triggeredBy,
    triggerSource: run.triggerSource,
    runDate: run.runDate,
    runNumber: run.runNumber,
    runLabel: run.runLabel,
    parentIssueId: run.parentIssueId,
    scheduledSlotId: run.scheduledSlotId,
    legacyPluginRunEntityId: run.legacyPluginRunEntityId,
    metadata: normalizeMetadata(run.metadata),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
  };
}

function mapWorkflowStepRun(sr: typeof workflowStepRuns.$inferSelect): WorkflowStepRun {
  return {
    id: sr.id,
    workflowRunId: sr.workflowRunId,
    stepId: sr.stepId,
    issueId: sr.issueId,
    status: sr.status,
    originalStatus: sr.originalStatus,
    agentName: sr.agentName,
    retryCount: sr.retryCount,
    sessionId: sr.sessionId,
    lastDispatchAttemptAt: sr.lastDispatchAttemptAt,
    lastDispatchAcceptedAt: sr.lastDispatchAcceptedAt,
    lastDispatchErrorAt: sr.lastDispatchErrorAt,
    lastDispatchErrorSummary: sr.lastDispatchErrorSummary,
    lastDispatchRequestId: sr.lastDispatchRequestId,
    legacyPluginStepEntityId: sr.legacyPluginStepEntityId,
    metadata: normalizeMetadata(sr.metadata),
    startedAt: sr.startedAt,
    completedAt: sr.completedAt,
  };
}

function mapWorkflowRunSlot(slot: typeof workflowRunSlots.$inferSelect): WorkflowRunSlot {
  return {
    id: slot.id,
    workflowDefinitionId: slot.workflowDefinitionId,
    companyId: slot.companyId,
    triggerSource: slot.triggerSource,
    scheduledAt: slot.scheduledAt,
    runDate: slot.runDate,
    timezone: slot.timezone,
    claimedAt: slot.claimedAt,
    status: slot.status,
    metadata: normalizeMetadata(slot.metadata),
  };
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
  const executionMode = input.executionMode ?? inferWorkflowExecutionMode(input.name, input.steps);

  await db.insert(workflowDefinitions).values({
    id,
    companyId: input.companyId,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? "active",
    stepsJson: input.steps,
    schedule: input.schedule ?? null,
    timezone: input.timezone ?? null,
    deadlineTime: input.deadlineTime ?? null,
    timeoutMinutes: input.timeoutMinutes ?? null,
    maxDailyRuns: input.maxDailyRuns ?? null,
    maxConcurrentRuns: input.maxConcurrentRuns ?? null,
    triggerLabels: input.triggerLabels ?? [],
    labelIds: input.labelIds ?? [],
    projectId: input.projectId ?? null,
    goalId: input.goalId ?? null,
    createParentIssuePolicy: input.createParentIssuePolicy ?? null,
    executionMode,
    dynamicPlanBootstrapOnly: input.dynamicPlanBootstrapOnly ?? false,
    source: input.source ?? "native",
    sourceKind: input.sourceKind ?? "workflow",
    legacyPluginEntityId: input.legacyPluginEntityId ?? null,
    legacyMetadata: input.legacyMetadata ?? {},
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
  return mapWorkflowDefinition(result[0]);
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

  return results.map(mapWorkflowDefinition);
}

/**
 * Update a workflow definition.
 */
export async function updateWorkflowDefinition(
  db: Db,
  id: string,
  updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">>,
): Promise<WorkflowDefinition | null> {
  const { steps, ...rest } = updates;
  const patch: Partial<typeof workflowDefinitions.$inferInsert> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(rest) as [keyof typeof rest, unknown][]) {
    if (value !== undefined) {
      (patch as Record<string, unknown>)[key as string] = value;
    }
  }
  if (steps) {
    patch.stepsJson = steps;
  }

  await db
    .update(workflowDefinitions)
    .set(patch)
    .where(eq(workflowDefinitions.id, id));

  return getWorkflowDefinitionById(db, id);
}

/**
 * Archive a workflow definition. Public REST delete semantics are archive-only.
 */
export async function deleteWorkflowDefinition(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .update(workflowDefinitions)
    .set({ status: "archived", updatedAt: new Date() })
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
    triggerSource: input.triggerSource ?? null,
    runDate: input.runDate ?? null,
    runNumber: input.runNumber ?? null,
    runLabel: input.runLabel ?? null,
    parentIssueId: input.parentIssueId ?? null,
    scheduledSlotId: input.scheduledSlotId ?? null,
    metadata: input.metadata ?? {},
    createdAt: now,
  });

  return getWorkflowRunById(db, id) as Promise<WorkflowRun>;
}

export async function claimWorkflowRunSlot(
  db: Db,
  input: {
    workflowDefinitionId: string;
    companyId: string;
    scheduledAt: Date;
    triggerSource?: string;
    runDate?: string | null;
    timezone?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<WorkflowRunSlot | null> {
  const triggerSource = input.triggerSource ?? "schedule";
  const [slot] = await db
    .insert(workflowRunSlots)
    .values({
      workflowDefinitionId: input.workflowDefinitionId,
      companyId: input.companyId,
      triggerSource,
      scheduledAt: input.scheduledAt,
      runDate: input.runDate ?? null,
      timezone: input.timezone ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [
        workflowRunSlots.workflowDefinitionId,
        workflowRunSlots.triggerSource,
        workflowRunSlots.scheduledAt,
      ],
    })
    .returning();

  return slot ? mapWorkflowRunSlot(slot) : null;
}

export async function recordWorkflowScheduleClaimed(
  db: Db,
  input: { workflowDefinitionId: string; scheduledAt: Date },
): Promise<void> {
  await db
    .update(workflowDefinitions)
    .set({
      lastScheduledRunAt: input.scheduledAt,
      lastScheduleError: null,
      lastScheduleErrorAt: null,
      updatedAt: new Date(),
    })
    .where(eq(workflowDefinitions.id, input.workflowDefinitionId));
}

export async function recordWorkflowScheduleFailure(
  db: Db,
  input: { workflowDefinitionId: string; error: string; failedAt?: Date },
): Promise<void> {
  await db
    .update(workflowDefinitions)
    .set({
      lastScheduleError: input.error,
      lastScheduleErrorAt: input.failedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowDefinitions.id, input.workflowDefinitionId));
}

export async function markWorkflowRunSlotFailed(
  db: Db,
  slotId: string,
  input: { error: string; metadata?: Record<string, unknown> },
): Promise<WorkflowRunSlot | null> {
  const [slot] = await db
    .update(workflowRunSlots)
    .set({
      status: "failed",
      metadata: {
        ...(input.metadata ?? {}),
        triggerError: input.error,
        triggerFailedAt: new Date().toISOString(),
      },
    })
    .where(eq(workflowRunSlots.id, slotId))
    .returning();

  return slot ? mapWorkflowRunSlot(slot) : null;
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
  return mapWorkflowRun(result[0]);
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
  return results.map(mapWorkflowRun);
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

  return results.map(mapWorkflowStepRun);
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
  const toolNames = Array.isArray(step?.toolNames)
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
  const updates: Partial<typeof workflowRuns.$inferInsert> = { status };
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updates.completedAt = new Date();
  }
  if (status === "running") {
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

  return run ? mapWorkflowRun(run) : null;
}

/**
 * Cancel a workflow run with company scope.
 */
export async function cancelWorkflowRun(db: Db, input: { id: string; companyId: string }): Promise<boolean> {
  const rows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(and(eq(workflowRuns.id, input.id), eq(workflowRuns.companyId, input.companyId)))
    .returning({ id: workflowRuns.id });

  return rows.length > 0;
}
