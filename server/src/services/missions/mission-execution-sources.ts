import type { Db } from "@paperclipai/db";
import { pluginEntities, workflowRuns } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export type MissionExecutionUnitKind =
  | "native_workflow_run"
  | "plugin_workflow_run"
  | "plugin_workflow_step_run";

export type MissionExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown";

export interface MissionExecutionSourceRef {
  type: MissionExecutionUnitKind;
  id: string;
  workflowRunId: string | null;
  stepId: string | null;
  issueId: string | null;
  pluginId: string | null;
  externalId: string | null;
}

export interface MissionExecutionUnit {
  id: string;
  kind: MissionExecutionUnitKind;
  companyId: string | null;
  missionId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  stepId: string | null;
  issueId: string | null;
  workflowName: string | null;
  title: string | null;
  status: MissionExecutionStatus;
  triggeredBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  pluginId: string | null;
  entityId: string;
  externalId: string | null;
  sourceRef: MissionExecutionSourceRef;
}

export interface MissionExecutionSourceSnapshot {
  missionId: string;
  companyId: string;
  units: MissionExecutionUnit[];
}

export interface NativeWorkflowRunExecutionSource {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: unknown;
  triggeredBy: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  workflowName?: string | null;
}

export interface PluginWorkflowRunEntityData extends Record<string, unknown> {
  workflowId?: unknown;
  workflowName?: unknown;
  companyId?: unknown;
  missionId?: unknown;
  status?: unknown;
  triggerSource?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

export interface PluginWorkflowStepRunEntityData extends Record<string, unknown> {
  workflowRunId?: unknown;
  runId?: unknown;
  stepId?: unknown;
  issueId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  missionId?: unknown;
  companyId?: unknown;
}

export interface PluginEntityExecutionSource<TData extends Record<string, unknown>> {
  id: string;
  pluginId: string;
  entityType: string;
  scopeKind: string;
  scopeId: string | null;
  externalId: string | null;
  title: string | null;
  status: string | null;
  data: TData;
  createdAt: Date;
  updatedAt: Date;
}

export interface MapPluginWorkflowStepRunExecutionUnitContext {
  companyId?: string | null;
  missionId?: string | null;
  workflowId?: string | null;
  workflowName?: string | null;
}

export interface ListMissionExecutionSourceSnapshotsInput {
  companyId: string;
  missionIds: string[];
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = asTrimmedString(value);
  if (!raw) return null;

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function getScopedCompanyId(scopeKind: string, scopeId: string | null): string | null {
  return scopeKind === "company" ? scopeId : null;
}

function getPluginWorkflowRunId(data: PluginWorkflowStepRunEntityData): string | null {
  return asTrimmedString(data.workflowRunId) ?? asTrimmedString(data.runId);
}

function getPluginWorkflowRunKeys(unit: MissionExecutionUnit): string[] {
  return [unit.id, unit.externalId].filter((value): value is string => Boolean(value));
}

function pluginEntityBelongsToCompany(
  entity: Pick<PluginEntityExecutionSource<Record<string, unknown>>, "scopeKind" | "scopeId" | "data">,
  companyId: string,
): boolean {
  if (entity.scopeKind !== "company" || entity.scopeId !== companyId) return false;

  const dataCompanyId = asTrimmedString(entity.data.companyId);
  return !dataCompanyId || dataCompanyId === companyId;
}

function createSourceRef(
  sourceType: MissionExecutionUnitKind,
  input: {
    entityId: string;
    workflowRunId?: string | null;
    stepId?: string | null;
    issueId?: string | null;
    pluginId?: string | null;
    externalId?: string | null;
  },
): MissionExecutionSourceRef {
  return {
    type: sourceType,
    id: input.entityId,
    workflowRunId: input.workflowRunId ?? null,
    stepId: input.stepId ?? null,
    issueId: input.issueId ?? null,
    pluginId: input.pluginId ?? null,
    externalId: input.externalId ?? null,
  };
}

export function normalizeMissionExecutionStatus(value: unknown): MissionExecutionStatus {
  const normalized = asTrimmedString(value)?.toLowerCase();
  switch (normalized) {
    case "pending":
      return "pending";
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "done":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "timed-out":
    case "timed_out":
    case "timeout":
      return "timed_out";
    default:
      return "unknown";
  }
}

export function isTerminalFailureStatus(status: MissionExecutionStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

export function mapNativeWorkflowRunToExecutionUnit(
  input: NativeWorkflowRunExecutionSource,
): MissionExecutionUnit {
  return {
    id: input.id,
    kind: "native_workflow_run",
    companyId: input.companyId,
    missionId: input.missionId,
    workflowId: input.workflowId,
    workflowRunId: input.id,
    stepId: null,
    issueId: null,
    workflowName: input.workflowName ?? null,
    title: input.workflowName ?? null,
    status: normalizeMissionExecutionStatus(input.status),
    triggeredBy: input.triggeredBy,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    createdAt: input.createdAt,
    updatedAt: input.completedAt ?? input.startedAt ?? input.createdAt,
    pluginId: null,
    entityId: input.id,
    externalId: null,
    sourceRef: createSourceRef("native_workflow_run", {
      entityId: input.id,
      workflowRunId: input.id,
    }),
  };
}

export function mapPluginWorkflowRunEntityToExecutionUnit(
  entity: PluginEntityExecutionSource<PluginWorkflowRunEntityData>,
): MissionExecutionUnit {
  const companyId = asTrimmedString(entity.data.companyId) ?? getScopedCompanyId(entity.scopeKind, entity.scopeId);
  const missionId = asTrimmedString(entity.data.missionId);
  const workflowName = asTrimmedString(entity.data.workflowName) ?? entity.title ?? null;

  return {
    id: entity.id,
    kind: "plugin_workflow_run",
    companyId,
    missionId,
    workflowId: asTrimmedString(entity.data.workflowId),
    workflowRunId: entity.id,
    stepId: null,
    issueId: null,
    workflowName,
    title: entity.title ?? workflowName,
    status: normalizeMissionExecutionStatus(entity.data.status ?? entity.status),
    triggeredBy: asTrimmedString(entity.data.triggerSource) ?? "plugin",
    startedAt: parseDate(entity.data.startedAt),
    completedAt: parseDate(entity.data.completedAt),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    pluginId: entity.pluginId,
    entityId: entity.id,
    externalId: entity.externalId,
    sourceRef: createSourceRef("plugin_workflow_run", {
      entityId: entity.id,
      workflowRunId: entity.id,
      pluginId: entity.pluginId,
      externalId: entity.externalId,
    }),
  };
}

export function mapPluginWorkflowStepRunEntityToExecutionUnit(
  entity: PluginEntityExecutionSource<PluginWorkflowStepRunEntityData>,
  context: MapPluginWorkflowStepRunExecutionUnitContext = {},
): MissionExecutionUnit {
  const workflowRunId = getPluginWorkflowRunId(entity.data);
  const stepId = asTrimmedString(entity.data.stepId) ?? entity.title ?? entity.id;
  const issueId = asTrimmedString(entity.data.issueId);
  const companyId =
    context.companyId
    ?? asTrimmedString(entity.data.companyId)
    ?? getScopedCompanyId(entity.scopeKind, entity.scopeId);
  const missionId = context.missionId ?? asTrimmedString(entity.data.missionId);

  return {
    id: entity.id,
    kind: "plugin_workflow_step_run",
    companyId,
    missionId,
    workflowId: context.workflowId ?? null,
    workflowRunId,
    stepId,
    issueId,
    workflowName: context.workflowName ?? null,
    title: entity.title ?? stepId,
    status: normalizeMissionExecutionStatus(entity.data.status ?? entity.status),
    triggeredBy: null,
    startedAt: parseDate(entity.data.startedAt),
    completedAt: parseDate(entity.data.completedAt),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    pluginId: entity.pluginId,
    entityId: entity.id,
    externalId: entity.externalId,
    sourceRef: createSourceRef("plugin_workflow_step_run", {
      entityId: entity.id,
      workflowRunId,
      stepId,
      issueId,
      pluginId: entity.pluginId,
      externalId: entity.externalId,
    }),
  };
}

export async function listMissionExecutionSourceSnapshots(
  db: Db,
  input: ListMissionExecutionSourceSnapshotsInput,
): Promise<Record<string, MissionExecutionSourceSnapshot>> {
  const missionIds = Array.from(
    new Set(input.missionIds.map((missionId) => missionId.trim()).filter((missionId) => missionId.length > 0)),
  );

  if (missionIds.length === 0) return {};

  const snapshots = Object.fromEntries(
    missionIds.map((missionId) => [
      missionId,
      {
        missionId,
        companyId: input.companyId,
        units: [],
      } satisfies MissionExecutionSourceSnapshot,
    ]),
  ) as Record<string, MissionExecutionSourceSnapshot>;

  const nativeRuns = await db
    .select()
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, input.companyId),
      inArray(workflowRuns.missionId, missionIds),
    ));

  for (const run of nativeRuns) {
    if (!run.missionId || !snapshots[run.missionId]) continue;
    snapshots[run.missionId].units.push(
      mapNativeWorkflowRunToExecutionUnit({
        id: run.id,
        workflowId: run.workflowId,
        companyId: run.companyId,
        missionId: run.missionId,
        status: run.status,
        triggeredBy: run.triggeredBy,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
      }),
    );
  }

  const missionIdSql = sql.join(missionIds.map((missionId) => sql`${missionId}`), sql`, `);
  const pluginRunEntities = await db
    .select()
    .from(pluginEntities)
    .where(and(
      eq(pluginEntities.entityType, "workflow-run"),
      eq(pluginEntities.scopeKind, "company"),
      eq(pluginEntities.scopeId, input.companyId),
      sql`${pluginEntities.data} ->> 'missionId' in (${missionIdSql})`,
    ));

  const pluginRunUnits = pluginRunEntities.flatMap((entity) => {
    const data = (entity.data ?? {}) as PluginWorkflowRunEntityData;
    if (!pluginEntityBelongsToCompany({ scopeKind: entity.scopeKind, scopeId: entity.scopeId, data }, input.companyId)) {
      return [];
    }

    return [mapPluginWorkflowRunEntityToExecutionUnit({
      id: entity.id,
      pluginId: entity.pluginId,
      entityType: entity.entityType,
      scopeKind: entity.scopeKind,
      scopeId: entity.scopeId,
      externalId: entity.externalId,
      title: entity.title,
      status: entity.status,
      data,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    })];
  });

  const pluginRunUnitByKey = new Map<string, MissionExecutionUnit>();
  for (const unit of pluginRunUnits) {
    for (const key of getPluginWorkflowRunKeys(unit)) {
      pluginRunUnitByKey.set(key, unit);
    }
  }
  for (const unit of pluginRunUnits) {
    if (!unit.missionId || !snapshots[unit.missionId]) continue;
    snapshots[unit.missionId].units.push(unit);
  }

  if (pluginRunUnits.length > 0) {
    const pluginRunKeys = Array.from(pluginRunUnitByKey.keys());
    const pluginRunIdSql = sql.join(pluginRunKeys.map((unitId) => sql`${unitId}`), sql`, `);
    const pluginStepRunEntities = await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-step-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, input.companyId),
        sql`coalesce(${pluginEntities.data} ->> 'workflowRunId', ${pluginEntities.data} ->> 'runId') in (${pluginRunIdSql})`,
      ));

    for (const entity of pluginStepRunEntities) {
      const data = (entity.data ?? {}) as PluginWorkflowStepRunEntityData;
      if (!pluginEntityBelongsToCompany({ scopeKind: entity.scopeKind, scopeId: entity.scopeId, data }, input.companyId)) {
        continue;
      }

      const workflowRunId = getPluginWorkflowRunId(data);
      if (!workflowRunId) continue;

      const parentRun = pluginRunUnitByKey.get(workflowRunId);
      if (!parentRun?.missionId || !snapshots[parentRun.missionId]) continue;

      snapshots[parentRun.missionId].units.push(
        mapPluginWorkflowStepRunEntityToExecutionUnit(
          {
            id: entity.id,
            pluginId: entity.pluginId,
            entityType: entity.entityType,
            scopeKind: entity.scopeKind,
            scopeId: entity.scopeId,
            externalId: entity.externalId,
            title: entity.title,
            status: entity.status,
            data,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
          },
          {
            companyId: parentRun.companyId,
            missionId: parentRun.missionId,
            workflowId: parentRun.workflowId,
            workflowName: parentRun.workflowName,
          },
        ),
      );
    }
  }

  for (const snapshot of Object.values(snapshots)) {
    snapshot.units.sort((left, right) => {
      const createdAtDelta = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
      if (createdAtDelta !== 0) return createdAtDelta;

      const kindDelta = left.kind.localeCompare(right.kind);
      if (kindDelta !== 0) return kindDelta;

      return left.id.localeCompare(right.id);
    });
  }

  return snapshots;
}
