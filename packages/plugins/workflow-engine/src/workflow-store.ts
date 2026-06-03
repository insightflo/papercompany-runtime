import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";

import { ENTITY_TYPES } from "./constants.js";
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";

export interface WorkflowDefinition extends Record<string, unknown> {
  name: string;
  description: string;
  companyId: string;
  status: "active" | "paused" | "archived";
  steps: WorkflowStep[];
  timeoutMinutes?: number;
  maxDailyRuns?: number;
  maxConcurrentRuns?: number;
  triggerLabels?: string[];
  labelIds?: string[];
  schedule?: string;
  timezone?: string;
  deadlineTime?: string;
  lastScheduledRunAt?: string;
  lastScheduleError?: string;
  lastScheduleErrorAt?: string;
  projectId?: string;
  goalId?: string;
  createParentIssuePolicy?: CreateParentIssuePolicy;
  /**
   * static_dag: create/advance all declared DAG steps.
   * dynamic_owner_plan: launch only root planning steps; the plan issue owns
   * child issue creation and the workflow run completes after launched steps end.
   */
  executionMode?: WorkflowExecutionMode;
  dynamicPlanBootstrapOnly?: boolean;
}

export interface WorkflowRun extends Record<string, unknown> {
  workflowId: string;
  workflowName: string;
  companyId: string;
  missionId?: string;
  status: "running" | "completed" | "failed" | "aborted" | "timed-out";
  parentIssueId?: string;
  runLabel?: string;
  runDate?: string;
  runNumber?: number;
  triggerSource?: "schedule" | "manual" | "label" | "api";
  startedAt: string;
  completedAt?: string;
}

export interface WorkflowStepRun extends Record<string, unknown> {
  runId: string;
  stepId: string;
  issueId?: string;
  agentName: string;
  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "done"
    | "failed"
    | "skipped"
    | "escalated";
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  lastDispatchAttemptAt?: string;
  lastDispatchAcceptedAt?: string;
  lastDispatchErrorAt?: string;
  lastDispatchErrorSummary?: string;
  lastDispatchRequestId?: string;
}

type TypedEntityRecord<T> = Omit<PluginEntityRecord, "data"> & { data: T };
type PluginEntityScopeKind = "instance" | "company" | "project" | "issue";

export function formatDateKeyInTimezone(date: Date, timezone?: string): string | null {
  if (!timezone) {
    return date.toISOString().slice(0, 10);
  }

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) {
      return null;
    }
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

function toTypedRecord<T>(
  record: PluginEntityRecord,
  entityType: string,
): TypedEntityRecord<T> {
  if (record.entityType !== entityType) {
    throw new Error(`Expected entity type "${entityType}", got "${record.entityType}"`);
  }

  return record as TypedEntityRecord<T>;
}

function toEntityData<T>(value: T): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function toScopeKind(value: unknown): PluginEntityScopeKind {
  if (value === "instance" || value === "company" || value === "project" || value === "issue") {
    return value;
  }

  return "company";
}

const inflightIdempotencyMarks = new Set<string>();

function makeExternalId(prefix: string): string {
  return `${prefix}:${Date.now()}:${randomUUID()}`;
}

function mergeEntityData<T extends object>(
  record: PluginEntityRecord,
  updates: Partial<T>,
): T {
  const merged = {
    ...(record.data as T),
    ...updates,
  };
  // Remove keys explicitly set to undefined so cleared fields are stored as absent
  for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

function isPluginEntityExternalIdConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "23505") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("plugin_entities_external_idx")
    || message.includes("duplicate key")
    || message.includes("unique constraint");
}

async function getEntityByType<T>(
  ctx: PluginContext,
  id: string,
  entityType: string,
): Promise<TypedEntityRecord<T> | null> {
  const pageSize = 200;
  let offset = 0;

  while (true) {
    const listed = await ctx.entities.list({
      entityType,
      limit: pageSize,
      offset,
    });

    const matched = listed.find(
      (record: PluginEntityRecord) => record.id === id && record.entityType === entityType,
    ) ?? null;

    if (matched) {
      return toTypedRecord<T>(matched, entityType);
    }

    if (listed.length < pageSize) {
      return null;
    }

    offset += listed.length;
  }
}

async function requireEntityByType<T>(
  ctx: PluginContext,
  id: string,
  entityType: string,
  label: string,
): Promise<TypedEntityRecord<T>> {
  const record = await getEntityByType<T>(ctx, id, entityType);

  if (!record) {
    throw new Error(`${label} not found: ${id}`);
  }

  return record;
}

async function listAllCompanyStepRuns(
  ctx: PluginContext,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const pageSize = 200;
  const stepRuns: PluginEntityRecord[] = [];
  let offset = 0;

  while (true) {
    const page = await ctx.entities.list({
      entityType: ENTITY_TYPES.workflowStepRun,
      scopeKind: "company",
      scopeId: companyId,
      limit: pageSize,
      offset,
    });

    stepRuns.push(...page);

    if (page.length < pageSize) {
      return stepRuns;
    }

    offset += page.length;
  }
}

async function listAllCompanyWorkflowRuns(
  ctx: PluginContext,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const pageSize = 200;
  const workflowRuns: PluginEntityRecord[] = [];
  let offset = 0;

  while (true) {
    const page = await ctx.entities.list({
      entityType: ENTITY_TYPES.workflowRun,
      scopeKind: "company",
      scopeId: companyId,
      limit: pageSize,
      offset,
    });

    workflowRuns.push(...page);

    if (page.length < pageSize) {
      return workflowRuns;
    }

    offset += page.length;
  }
}

export async function createWorkflowDefinition(
  ctx: PluginContext,
  def: WorkflowDefinition,
): Promise<PluginEntityRecord> {
  return await ctx.entities.upsert({
    entityType: ENTITY_TYPES.workflowDefinition,
    scopeKind: "company",
    scopeId: def.companyId,
    externalId: makeExternalId(`workflow-definition:${def.companyId}`),
    title: def.name,
    status: def.status,
    data: toEntityData(def),
  });
}

export async function getWorkflowDefinition(
  ctx: PluginContext,
  id: string,
): Promise<(PluginEntityRecord & { data: WorkflowDefinition }) | null> {
  return await getEntityByType<WorkflowDefinition>(
    ctx,
    id,
    ENTITY_TYPES.workflowDefinition,
  );
}

export async function listWorkflowDefinitions(
  ctx: PluginContext,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  return await ctx.entities.list({
    entityType: ENTITY_TYPES.workflowDefinition,
    scopeKind: "company",
    scopeId: companyId,
  });
}

export async function updateWorkflowDefinition(
  ctx: PluginContext,
  id: string,
  updates: Partial<WorkflowDefinition>,
): Promise<PluginEntityRecord> {
  const current = await requireEntityByType<WorkflowDefinition>(
    ctx,
    id,
    ENTITY_TYPES.workflowDefinition,
    "Workflow definition",
  );
  const data = mergeEntityData<WorkflowDefinition>(current, updates);

  return await ctx.entities.upsert({
    entityType: current.entityType,
    scopeKind: toScopeKind(current.scopeKind),
    scopeId: current.scopeId ?? undefined,
    externalId: current.externalId ?? `workflow-definition:${current.id}`,
    title: data.name,
    status: data.status,
    data: toEntityData(data),
  });
}

export async function createWorkflowRun(
  ctx: PluginContext,
  run: WorkflowRun,
): Promise<PluginEntityRecord> {
  return await ctx.entities.upsert({
    entityType: ENTITY_TYPES.workflowRun,
    scopeKind: "company",
    scopeId: run.companyId,
    externalId: makeExternalId(`workflow-run:${run.companyId}:${run.workflowId}`),
    title: `${run.workflowName} run`,
    status: run.status,
    data: toEntityData(run),
  });
}

export async function getWorkflowRun(
  ctx: PluginContext,
  id: string,
): Promise<(PluginEntityRecord & { data: WorkflowRun }) | null> {
  return await getEntityByType<WorkflowRun>(ctx, id, ENTITY_TYPES.workflowRun);
}

export async function listActiveRuns(
  ctx: PluginContext,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const runs = await listAllCompanyWorkflowRuns(ctx, companyId);

  return runs.filter((run: PluginEntityRecord) => {
    const runCompanyId = typeof (run.data as Partial<WorkflowRun>).companyId === "string"
      ? (run.data as Partial<WorkflowRun>).companyId!.trim()
      : "";
    return run.status === "running" && runCompanyId === companyId;
  });
}

export async function listRecentRuns(
  ctx: PluginContext,
  companyId: string,
  limit = 20,
): Promise<PluginEntityRecord[]> {
  const runs = await listAllCompanyWorkflowRuns(ctx, companyId);

  return runs
    .filter((run: PluginEntityRecord) => {
      const runCompanyId = typeof (run.data as Partial<WorkflowRun>).companyId === "string"
        ? (run.data as Partial<WorkflowRun>).companyId!.trim()
        : "";
      return runCompanyId === companyId;
    })
    .sort((a: PluginEntityRecord, b: PluginEntityRecord) => {
      const aData = a.data as Partial<WorkflowRun>;
      const bData = b.data as Partial<WorkflowRun>;
      const aTime = Date.parse(aData.completedAt ?? aData.startedAt ?? "") || 0;
      const bTime = Date.parse(bData.completedAt ?? bData.startedAt ?? "") || 0;
      return bTime - aTime;
    })
    .slice(0, Math.max(0, limit));
}

export async function listWorkflowRunsByWorkflowId(
  ctx: PluginContext,
  companyId: string,
  workflowId: string,
): Promise<PluginEntityRecord[]> {
  const runs = await listAllCompanyWorkflowRuns(ctx, companyId);

  return runs.filter(
    (run: PluginEntityRecord) =>
      (run.data as Partial<WorkflowRun>).workflowId === workflowId &&
      (run.data as Partial<WorkflowRun>).companyId === companyId,
  );
}

export async function updateWorkflowRun(
  ctx: PluginContext,
  id: string,
  updates: Partial<WorkflowRun>,
): Promise<PluginEntityRecord> {
  const current = await requireEntityByType<WorkflowRun>(
    ctx,
    id,
    ENTITY_TYPES.workflowRun,
    "Workflow run",
  );
  const data = mergeEntityData<WorkflowRun>(current, updates);

  return await ctx.entities.upsert({
    entityType: current.entityType,
    scopeKind: toScopeKind(current.scopeKind),
    scopeId: current.scopeId ?? undefined,
    externalId: current.externalId ?? `workflow-run:${current.id}`,
    title: `${data.workflowName} run`,
    status: data.status,
    data: toEntityData(data),
  });
}

export async function createStepRun(
  ctx: PluginContext,
  companyId: string,
  stepRun: WorkflowStepRun,
): Promise<PluginEntityRecord> {
  return await ctx.entities.upsert({
    entityType: ENTITY_TYPES.workflowStepRun,
    scopeKind: "company",
    scopeId: companyId,
    externalId: `${stepRun.runId}:${stepRun.stepId}`,
    title: stepRun.stepId,
    status: stepRun.status,
    data: toEntityData(stepRun),
  });
}

export async function getStepRun(
  ctx: PluginContext,
  id: string,
): Promise<(PluginEntityRecord & { data: WorkflowStepRun }) | null> {
  return await getEntityByType<WorkflowStepRun>(
    ctx,
    id,
    ENTITY_TYPES.workflowStepRun,
  );
}

export async function listStepRuns(
  ctx: PluginContext,
  runId: string,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const stepRuns = await listAllCompanyStepRuns(ctx, companyId);

  return stepRuns.filter(
    (stepRun: PluginEntityRecord) =>
      (stepRun.data as Partial<WorkflowStepRun>).runId === runId,
  );
}

export async function findStepRunByIssueId(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<PluginEntityRecord | null> {
  const stepRuns = await listAllCompanyStepRuns(ctx, companyId);

  return (
    stepRuns.find(
      (stepRun: PluginEntityRecord) =>
        (stepRun.data as Partial<WorkflowStepRun>).issueId === issueId,
    ) ?? null
  );
}

export async function updateStepRun(
  ctx: PluginContext,
  id: string,
  updates: Partial<WorkflowStepRun>,
): Promise<PluginEntityRecord> {
  const current = await requireEntityByType<WorkflowStepRun>(
    ctx,
    id,
    ENTITY_TYPES.workflowStepRun,
    "Workflow step run",
  );
  const data = mergeEntityData<WorkflowStepRun>(current, updates);

  return await ctx.entities.upsert({
    entityType: current.entityType,
    scopeKind: toScopeKind(current.scopeKind),
    scopeId: current.scopeId ?? undefined,
    externalId: current.externalId ?? `${data.runId}:${data.stepId}`,
    title: data.stepId,
    status: data.status,
    data: toEntityData(data),
  });
}

export async function checkIdempotency(
  ctx: PluginContext,
  key: string,
  companyId: string,
): Promise<boolean> {
  const pageSize = 500;
  let offset = 0;

  while (true) {
    const page = await ctx.entities.list({
      entityType: ENTITY_TYPES.idempotencyKey,
      scopeKind: "company",
      scopeId: companyId,
      limit: pageSize,
      offset,
    });

    if (page.some((record: PluginEntityRecord) => record.externalId === key)) {
      return true;
    }

    if (page.length < pageSize) {
      return false;
    }

    offset += page.length;
  }
}

export async function markIdempotency(
  ctx: PluginContext,
  key: string,
  companyId: string,
): Promise<void> {
  const scopedKey = `${companyId}:${key}`;
  if (inflightIdempotencyMarks.has(scopedKey)) {
    return;
  }

  if (await checkIdempotency(ctx, key, companyId)) {
    return;
  }

  inflightIdempotencyMarks.add(scopedKey);
  try {
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.idempotencyKey,
      scopeKind: "company",
      scopeId: companyId,
      externalId: key,
      title: key,
      status: "processed",
      data: {
        processedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (!isPluginEntityExternalIdConflict(error)) {
      throw error;
    }

    const exists = await checkIdempotency(ctx, key, companyId);
    if (!exists) {
      throw error;
    }
  } finally {
    inflightIdempotencyMarks.delete(scopedKey);
  }
}
