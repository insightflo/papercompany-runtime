import type { Db } from "@paperclipai/db";
import { pluginEntities, workflowRuns } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { missionAgentRuntimes, agents, issues } from "@paperclipai/db";
import {
  MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT,
  findBackingHeartbeatRunDetail,
} from "./mission-runtime-manager.js";

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
  /** [런타임 라이브니스 — 2026-09-01 표시 개선] 활성 미션 런타임의 실행 중 인 상세. */
  runtimes: MissionRuntimeLivenessEntry[];
}

export interface MissionRuntimeLivenessEntry {
  runtimeId: string;
  agentId: string;
  agentName: string | null;
  adapterType: string;
  workspaceKey: string;
  status: string;
  currentIssueId: string | null;
  currentIssueIdentifier: string | null;
  runCount: number;
  lastRunStatus: string | null;
  lastError: string | null;
  /** busy 상태일 때 now−updatedAt (ms). */
  busySinceMs: number | null;
  /** busy를 뒷받침하는 비종료(queued/running) 런 상세(없으면 null). */
  backingRun: {
    id: string;
    status: string;
    issueId: string | null;
    startedAt: Date | null;
    updatedAt: Date;
    elapsedMs: number;
    /** 런 row 마지막 갱신 후 경과 (execution_stale 판정 표시용). */
    idleMs: number;
  } | null;
  /** busy + 백킹 런 없음 + grace 경과 — 회수기가 idle로 전환 예정. */
  staleBusy: boolean;
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
  /** 라이브니스 경과 계산 기준 시각(기본 now). */
  now?: Date;
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
        runtimes: [],
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

  await attachMissionRuntimeLiveness(db, snapshots, input.companyId, input.now ?? new Date());

  return snapshots;
}

/**
 * [런타임 라이브니스 부착 — 2026-09-01 표시 개선]
 * 감독/거버넌스/오너 회복 판단이 "busy인데 PID가 비어 있다 → 죽음"으로 오판하지 않도록,
 * 활성 런타임마다 백킹 런(비종료 heartbeat run) 상세를 스냅샷에 남긴다.
 * process_pid는 이 디스패치 경로에서 기록되지 않으므로 PID는 사망 판단 근거가 아니다.
 */
async function attachMissionRuntimeLiveness(
  db: Db,
  snapshots: Record<string, MissionExecutionSourceSnapshot>,
  companyId: string,
  now: Date,
): Promise<void> {
  const missionIds = Object.keys(snapshots);
  if (missionIds.length === 0) return;

  const rows = await db
    .select({
      runtime: missionAgentRuntimes,
      agentName: agents.name,
    })
    .from(missionAgentRuntimes)
    .innerJoin(agents, eq(missionAgentRuntimes.agentId, agents.id))
    .where(and(
      eq(missionAgentRuntimes.companyId, companyId),
      inArray(missionAgentRuntimes.missionId, missionIds),
      inArray(missionAgentRuntimes.status, ["starting", "ready", "busy", "idle"]),
    ))
    .orderBy(sql`${missionAgentRuntimes.updatedAt} desc`)
    .limit(60);

  const currentIssueIds = Array.from(new Set(
    rows.map((row) => row.runtime.currentIssueId).filter((id): id is string => Boolean(id)),
  ));
  const identifierByIssueId = new Map<string, string>();
  if (currentIssueIds.length > 0) {
    const issueRows = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(inArray(issues.id, currentIssueIds))
      .limit(currentIssueIds.length);
    for (const issue of issueRows) {
      if (issue.identifier) identifierByIssueId.set(issue.id, issue.identifier);
    }
  }

  for (const { runtime, agentName } of rows) {
    const snapshot = snapshots[runtime.missionId];
    if (!snapshot) continue;
    const busy = runtime.status === "busy";
    const busySinceMs = busy ? Math.max(0, now.getTime() - runtime.updatedAt.getTime()) : null;
    const backing = busy ? await findBackingHeartbeatRunDetail(db, runtime) : null;
    snapshot.runtimes.push({
      runtimeId: runtime.id,
      agentId: runtime.agentId,
      agentName,
      adapterType: runtime.adapterType,
      workspaceKey: runtime.workspaceKey,
      status: runtime.status,
      currentIssueId: runtime.currentIssueId ?? null,
      currentIssueIdentifier: runtime.currentIssueId ? identifierByIssueId.get(runtime.currentIssueId) ?? null : null,
      runCount: runtime.runCount,
      lastRunStatus: runtime.lastRunStatus ?? null,
      lastError: runtime.lastError ?? null,
      busySinceMs,
      backingRun: backing
        ? {
          id: backing.id,
          status: backing.status,
          issueId: backing.issueId,
          startedAt: backing.startedAt,
          updatedAt: backing.updatedAt,
          elapsedMs: Math.max(0, now.getTime() - (backing.startedAt?.getTime() ?? backing.updatedAt.getTime())),
          idleMs: Math.max(0, now.getTime() - backing.updatedAt.getTime()),
        }
        : null,
      staleBusy: busy && !backing && (busySinceMs ?? 0) >= MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT,
    });
  }
}
