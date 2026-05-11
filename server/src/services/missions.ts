/**
 * Mission Service
 *
 * CRUD operations for missions and mission_agents.
 * OQ-4 schema: owner_agent_id is the mission main executor; mission_agents carries executor/reviewer/observer roles.
 */

import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  issueComments,
  issues,
  missionAgents,
  missionPlanArtifacts,
  missionSessions,
  missions,
  pluginEntities,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { notFound, badRequest } from "../errors.js";
import { issueService } from "./issues.js";
import { missionPlanArtifactService } from "./mission-plan-artifacts.js";
import { syncWorkflowRunState, type WorkflowStep } from "./workflow/dag-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mission status.
 */
export type MissionStatus = "planning" | "active" | "completed" | "cancelled" | "paused";

/**
 * Mission agent role.
 */
export type MissionAgentRole = "executor" | "reviewer" | "observer";

/**
 * Mission row type.
 */
export type MissionRow = typeof missions.$inferSelect;

/**
 * MissionAgent row type.
 */
export type MissionAgentRow = typeof missionAgents.$inferSelect;

/**
 * Full mission detail with agents.
 */
export type MissionDetail = MissionRow & {
  agents: Array<MissionAgentRow & { agentName?: string }>;
  ownerAgentName?: string;
  sessionBindings: Array<{
    agentId: string;
    adapterType: string;
    status: string;
    lastActiveAt: Date | null;
    runCount: number;
  }>;
};

export type MissionWorkflowStepIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

export type MissionWorkflowRunProgress = {
  totalSteps: number;
  pendingSteps: number;
  runningSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
};

export type MissionWorkflowRunStep = {
  stepId: string;
  name: string;
  agentId: string;
  dependencies: string[];
  description: string | null;
  toolNames: string[];
  knowledgeBaseIds: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  issueId: string | null;
  issue: MissionWorkflowStepIssue | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

const MISSION_WORKFLOW_STEP_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const);

function normalizeMissionWorkflowStepStatus(status: string): MissionWorkflowRunStep["status"] {
  return MISSION_WORKFLOW_STEP_STATUSES.has(status as MissionWorkflowRunStep["status"])
    ? (status as MissionWorkflowRunStep["status"])
    : "pending";
}

export type MissionWorkflowRunDetail = typeof workflowRuns.$inferSelect & {
  workflowName: string | null;
  stepRuns: Array<typeof workflowStepRuns.$inferSelect>;
  steps: MissionWorkflowRunStep[];
  progress: MissionWorkflowRunProgress;
};
export type MissionIssueTree = Awaited<ReturnType<ReturnType<typeof issueService>["list"]>>;

export type MissionOwnerSupervisionRecommendationType =
  | "dispatch_missing_step"
  | "retry_failed_step_if_safe"
  | "request_replan"
  | "escalate_blocked";

export type MissionOwnerSupervisionRecommendation = {
  type: MissionOwnerSupervisionRecommendationType;
  missionId: string;
  reason: string;
  safeToAutoApply: boolean;
  workflowRunId?: string;
  stepId?: string;
  issueId?: string;
};

export type MissionOwnerSupervisionAppliedAction = {
  type: "dispatch_missing_step";
  missionId: string;
  workflowRunId: string;
  stepIds: string[];
  resultStatus: string;
};

export type MissionOwnerSupervisionResult = {
  missionId: string;
  oversightIssueId: string | null;
  findings: string[];
  recommendations: MissionOwnerSupervisionRecommendation[];
  appliedActions: MissionOwnerSupervisionAppliedAction[];
  commented: boolean;
};

export type ActiveMissionOwnerSupervisionResult = {
  companyId?: string;
  missionIds: string[];
  missions: MissionOwnerSupervisionResult[];
};

/**
 * Input for creating a mission.
 */
export interface CreateMissionInput {
  companyId: string;
  ownerAgentId: string;
  title: string;
  description?: string;
  goalId?: string;
  status?: MissionStatus;
  source?: "manual" | "workflow";
  agentIds?: Array<{ agentId: string; role: MissionAgentRole }>;
}

/**
 * Input for updating a mission.
 */
export interface UpdateMissionInput {
  title?: string;
  description?: string;
  status?: MissionStatus;
  goalId?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * Input for adding an agent to a mission.
 */
export interface AddMissionAgentInput {
  missionId: string;
  agentId: string;
  role?: MissionAgentRole;
}

/**
 * Filter options for listing missions.
 */
export interface ListMissionsFilter {
  companyId: string;
  status?: MissionStatus;
  ownerAgentId?: string;
  goalId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "updatedAt" | "title" | "status";
  sortOrder?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATUSES: MissionStatus[] = ["planning", "active", "completed", "cancelled", "paused"];
const VALID_ROLES: MissionAgentRole[] = ["executor", "reviewer", "observer"];

function validateStatus(status: string): asserts status is MissionStatus {
  if (!VALID_STATUSES.includes(status as MissionStatus)) {
    throw badRequest(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}

function validateRole(role: string): asserts role is MissionAgentRole {
  if (!VALID_ROLES.includes(role as MissionAgentRole)) {
    throw badRequest(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(", ")}`);
  }
}

function assertMissionId(value: string): void {
  if (!isUuidLike(value)) {
    throw badRequest(`Invalid mission id: ${value}`);
  }
}

function buildWorkflowRunProgress(steps: MissionWorkflowRunStep[]): MissionWorkflowRunProgress {
  return steps.reduce<MissionWorkflowRunProgress>(
    (acc, step) => {
      acc.totalSteps += 1;
      switch (step.status) {
        case "completed":
          acc.completedSteps += 1;
          break;
        case "failed":
          acc.failedSteps += 1;
          break;
        case "running":
          acc.runningSteps += 1;
          break;
        case "skipped":
          acc.skippedSteps += 1;
          break;
        default:
          acc.pendingSteps += 1;
          break;
      }
      return acc;
    },
    {
      totalSteps: 0,
      pendingSteps: 0,
      runningSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
    },
  );
}

type PluginWorkflowStepData = Record<string, unknown>;
type PluginWorkflowDefinitionData = {
  name?: unknown;
  steps?: unknown;
};
type PluginWorkflowRunData = {
  workflowId?: unknown;
  workflowName?: unknown;
  companyId?: unknown;
  missionId?: unknown;
  status?: unknown;
  triggerSource?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};
type PluginWorkflowStepRunData = {
  runId?: unknown;
  stepId?: unknown;
  issueId?: unknown;
  agentName?: unknown;
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parsePluginDate(value: unknown): Date | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function parseMissionDateFilter(value: string, boundary: "start" | "end"): Date {
  const normalized = value.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999,
    );
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`Invalid mission date filter: ${value}`);
  }
  return new Date(parsed);
}

function normalizePluginWorkflowStepStatus(status: unknown): MissionWorkflowRunStep["status"] {
  const normalized = asTrimmedString(status);
  switch (normalized) {
    case "done":
      return "completed";
    case "in_progress":
      return "running";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "running":
    case "completed":
    case "pending":
      return normalizeMissionWorkflowStepStatus(normalized);
    default:
      return "pending";
  }
}

function toPluginWorkflowStepData(value: unknown): PluginWorkflowStepData | null {
  if (!isRecord(value)) return null;
  const id = asTrimmedString(value.id);
  if (!id) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function missionService(db: Db) {
  const activeWorkflowRunStatuses = new Set(["pending", "queued", "running", "in_progress"]);
  const failedWorkflowRunStatuses = new Set(["aborted", "failed", "cancelled", "canceled", "error"]);
  const completedWorkflowRunStatuses = new Set(["completed", "succeeded", "done"]);

  async function reconcileMissionStatusFromWorkflowRuns(mission: MissionRow): Promise<MissionRow> {
    const isWorkflowCreatedMission = mission.description?.startsWith("Created automatically for workflow run:") ?? false;
    const canReconcileTerminalWorkflowMission =
      isWorkflowCreatedMission && (mission.status === "completed" || mission.status === "cancelled");
    if (mission.status !== "active" && !canReconcileTerminalWorkflowMission) return mission;

    const linkedRuns: Array<{ status: string; completedAt: Date | null }> = [];
    const nativeRuns = await db
      .select({ status: workflowRuns.status, completedAt: workflowRuns.completedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.missionId, mission.id));
    for (const run of nativeRuns) {
      linkedRuns.push({ status: run.status, completedAt: run.completedAt });
    }

    const pluginRunEntities = await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, mission.companyId),
      ));
    for (const entity of pluginRunEntities) {
      const data = entity.data as PluginWorkflowRunData;
      if (data.companyId !== mission.companyId || data.missionId !== mission.id) continue;
      linkedRuns.push({
        status: asTrimmedString(data.status) ?? entity.status ?? "",
        completedAt: parsePluginDate(data.completedAt) ?? entity.updatedAt ?? null,
      });
    }

    if (linkedRuns.length === 0) return mission;

    const normalizedStatuses = linkedRuns.map((run) => run.status.trim().toLowerCase()).filter(Boolean);
    if (normalizedStatuses.some((status) => activeWorkflowRunStatuses.has(status))) {
      if (mission.status === "active" && mission.completedAt === null) return mission;
      const updates: Partial<MissionRow> = {
        status: "active",
        completedAt: null,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));
      return {
        ...mission,
        ...updates,
      };
    }
    if (normalizedStatuses.some((status) => !failedWorkflowRunStatuses.has(status) && !completedWorkflowRunStatuses.has(status))) {
      return mission;
    }

    const nextStatus: MissionStatus = normalizedStatuses.some((status) => failedWorkflowRunStatuses.has(status))
      ? "cancelled"
      : "completed";
    const completedAt = linkedRuns
      .map((run) => run.completedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? new Date();

    const updates: Partial<MissionRow> = {
      status: nextStatus,
      completedAt,
      updatedAt: new Date(),
    };
    await db.update(missions).set(updates).where(eq(missions.id, mission.id));

    return {
      ...mission,
      ...updates,
    };
  }

  async function collectWorkflowIssueIdsForMission(mission: MissionRow): Promise<string[]> {
    const issueIds = new Set<string>();

    const nativeRuns = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)));
    if (nativeRuns.length > 0) {
      const nativeStepRuns = await db
        .select({ issueId: workflowStepRuns.issueId })
        .from(workflowStepRuns)
        .where(inArray(workflowStepRuns.workflowRunId, nativeRuns.map((run) => run.id)));
      for (const stepRun of nativeStepRuns) {
        if (stepRun.issueId) issueIds.add(stepRun.issueId);
      }
    }

    const pluginRunEntities = await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, mission.companyId),
      ));
    const pluginRunIds = pluginRunEntities
      .filter((entity) => {
        const data = entity.data as PluginWorkflowRunData;
        return data.companyId === mission.companyId && data.missionId === mission.id;
      })
      .map((entity) => entity.id);

    if (pluginRunIds.length > 0) {
      const pluginStepRunEntities = await db
        .select()
        .from(pluginEntities)
        .where(and(
          eq(pluginEntities.entityType, "workflow-step-run"),
          eq(pluginEntities.scopeKind, "company"),
          eq(pluginEntities.scopeId, mission.companyId),
        ));
      for (const entity of pluginStepRunEntities) {
        const data = entity.data as PluginWorkflowStepRunData;
        const runId = asTrimmedString(data.runId);
        const issueId = asTrimmedString(data.issueId);
        if (runId && issueId && pluginRunIds.includes(runId)) issueIds.add(issueId);
      }
    }

    return [...issueIds];
  }

  async function collectIssueIdsWithAncestors(companyId: string, seedIssueIds: string[]): Promise<string[]> {
    const result = new Set<string>();
    const visited = new Set<string>();
    let frontier = [...new Set(seedIssueIds)];

    while (frontier.length > 0) {
      const current = frontier.filter((id) => !visited.has(id));
      if (current.length === 0) break;
      for (const id of current) visited.add(id);

      const rows = await db
        .select({ id: issues.id, parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, current)));

      const next: string[] = [];
      for (const row of rows) {
        result.add(row.id);
        if (row.parentId && !visited.has(row.parentId)) next.push(row.parentId);
      }
      frontier = next;
    }

    return [...result];
  }

  async function ensureWorkflowIssuesLinkedToMission(mission: MissionRow): Promise<void> {
    const workflowIssueIds = await collectWorkflowIssueIdsForMission(mission);
    if (workflowIssueIds.length === 0) return;

    const issueIdsWithAncestors = await collectIssueIdsWithAncestors(mission.companyId, workflowIssueIds);
    if (issueIdsWithAncestors.length === 0) return;

    await db
      .update(issues)
      .set({ missionId: mission.id, updatedAt: new Date() })
      .where(and(eq(issues.companyId, mission.companyId), inArray(issues.id, issueIdsWithAncestors)));
  }

  async function findMainExecutorIssue(missionId: string, originKind: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.missionId, missionId), eq(issues.originKind, originKind)))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMainExecutorPlanningIssue(mission: MissionRow) {
    const existing = await findMainExecutorIssue(mission.id, "mission_main_executor_plan");
    if (existing) return existing;

    return issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: [
        "Plan and coordinate the mission before execution begins.",
        "",
        `Mission: ${mission.title}`,
        mission.description ? `Brief: ${mission.description}` : null,
        "",
        "Expected output:",
        "- Break down the work into executable issues or workflow runs.",
        "- Identify blockers and approval needs early.",
        "- Keep this issue updated with the current plan.",
      ].filter(Boolean).join("\n"),
      missionId: mission.id,
      originKind: "mission_main_executor_plan",
      priority: "medium",
      status: "todo",
      title: `[Plan] ${mission.title}`,
    });
  }

  async function ensureWorkflowMissionPlanArtifact(
    mission: MissionRow,
    oversightIssue: typeof issues.$inferSelect,
    workflowName: string,
    metadata: { workflowStepIds?: string[]; sourceRunId?: string } = {},
  ): Promise<void> {
    const refs = {
      oversightIssueId: oversightIssue.id,
      workflowName,
      ...(metadata.workflowStepIds ? { workflowStepIds: metadata.workflowStepIds } : {}),
      ...(metadata.sourceRunId ? { sourceRunId: metadata.sourceRunId } : {}),
    };
    const planSvc = missionPlanArtifactService(db);
    const activePlan = await planSvc.getActiveMissionPlan({ companyId: mission.companyId, missionId: mission.id });
    if (activePlan) {
      const currentRefs = typeof activePlan.refs === "object" && activePlan.refs !== null && !Array.isArray(activePlan.refs)
        ? activePlan.refs as Record<string, unknown>
        : {};
      const mergedRefs = { ...currentRefs, ...refs };
      const changed = JSON.stringify(currentRefs) !== JSON.stringify(mergedRefs);
      if (changed) {
        await db
          .update(missionPlanArtifacts)
          .set({ refs: mergedRefs, updatedAt: new Date() })
          .where(eq(missionPlanArtifacts.id, activePlan.id));
      }
      return;
    }

    await planSvc.createInitialMissionPlan({
      companyId: mission.companyId,
      missionId: mission.id,
      refs,
      assumptions: [
        "Workflow-created mission: the main executor owns supervision, diagnosis, recovery/replan, and escalation rather than only executing a single step.",
      ],
      requiredInputs: [
        { key: "workflow-step-state", status: "tracked", source: "workflow_runs/workflow_step_runs/issues" },
        { key: "owner-judgement", status: "ongoing", source: "mission_main_executor_oversight" },
      ],
      successCriteria: [
        { description: "All workflow steps are completed or explicitly diagnosed as blocked/impossible with evidence." },
        { description: "The main executor oversight issue records the current judgement, recovery/replan, or escalation path." },
      ],
      risks: [
        { description: "Step dispatch omission or stale unstarted work can leave the mission active without owner-visible diagnosis.", category: "dispatch_gap", severity: "observe" },
      ],
      steps: [
        { id: "supervise", title: "Supervise workflow step progress and detect stale/blocked/failing work", status: "ongoing", intendedRole: "mission_owner" },
        { id: "diagnose", title: "Diagnose failures or dispatch omissions with evidence", status: "planned", intendedRole: "mission_owner" },
        { id: "recover-or-escalate", title: "Recover, replan, or report impossible completion", status: "planned", intendedRole: "mission_owner" },
      ],
    });
  }

  async function ensureMainExecutorOversightIssue(
    mission: MissionRow,
    workflowName: string,
    metadata: { workflowStepIds?: string[]; sourceRunId?: string } = {},
  ): Promise<typeof issues.$inferSelect> {
    const existing = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (existing) {
      await ensureWorkflowMissionPlanArtifact(mission, existing, workflowName, metadata);
      return existing;
    }

    const oversightIssue = await issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: [
        "Monitor this workflow-created mission and keep execution moving.",
        "",
        `Mission: ${mission.title}`,
        `Workflow: ${workflowName}`,
        "",
        "Main executor duties:",
        "- Watch step progress and comments.",
        "- Comment on failed, stale, undispatched, or blocked steps with the current judgement.",
        "- Retry failed workflow steps when retry is safe and within the retry limit.",
        "- Recover/replan toward completion, or escalate/report impossible states with evidence.",
      ].join("\n"),
      missionId: mission.id,
      originKind: "mission_main_executor_oversight",
      priority: "medium",
      status: "todo",
      title: `[Oversight] ${workflowName}`,
    });
    await ensureWorkflowMissionPlanArtifact(mission, oversightIssue, workflowName, metadata);
    return oversightIssue;
  }

  async function runMainExecutorSupervision(input: {
    missionId: string;
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
  }): Promise<MissionOwnerSupervisionResult> {
    const mission = await db
      .select()
      .from(missions)
      .where(eq(missions.id, input.missionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

    const oversightIssue = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (!oversightIssue) {
      return { missionId: mission.id, oversightIssueId: null, findings: [], recommendations: [], appliedActions: [], commented: false };
    }

    const now = input.now ?? new Date();
    const staleAfterMs = Math.max(1, input.staleAfterMinutes ?? 120) * 60 * 1000;
    const missionIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id)))
      .orderBy(asc(issues.createdAt), asc(issues.id));

    const missionIssueIds = missionIssues.map((issue) => issue.id);
    const missionIssueById = new Map(missionIssues.map((issue) => [issue.id, issue]));
    const issueCommentRows = missionIssueIds.length > 0
      ? await db
        .select({ issueId: issueComments.issueId, body: issueComments.body })
        .from(issueComments)
        .where(inArray(issueComments.issueId, missionIssueIds))
      : [];
    const commentsByIssueId = new Map<string, string[]>();
    for (const comment of issueCommentRows) {
      const list = commentsByIssueId.get(comment.issueId) ?? [];
      list.push(comment.body);
      commentsByIssueId.set(comment.issueId, list);
    }
    const issueRunRows = missionIssueIds.length > 0
      ? await db
        .select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, mission.companyId), inArray(heartbeatRuns.issueId, missionIssueIds)))
      : [];
    const heartbeatCountByIssueId = new Map<string, number>();
    for (const run of issueRunRows) {
      if (!run.issueId) continue;
      heartbeatCountByIssueId.set(run.issueId, (heartbeatCountByIssueId.get(run.issueId) ?? 0) + 1);
    }

    const stepRows = await db
      .select({
        stepRun: workflowStepRuns,
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
      .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)))
      .orderBy(asc(workflowRuns.createdAt), asc(workflowStepRuns.stepId));
    const stepRowsByIssueId = new Map<string, typeof stepRows>();
    for (const row of stepRows) {
      if (!row.stepRun.issueId) continue;
      const list = stepRowsByIssueId.get(row.stepRun.issueId) ?? [];
      list.push(row);
      stepRowsByIssueId.set(row.stepRun.issueId, list);
    }

    const findings: string[] = [];
    const recommendations: MissionOwnerSupervisionRecommendation[] = [];
    const addRecommendation = (recommendation: MissionOwnerSupervisionRecommendation) => {
      const key = `${recommendation.type}:${recommendation.workflowRunId ?? ""}:${recommendation.stepId ?? ""}:${recommendation.issueId ?? ""}`;
      if (recommendations.some((existing) => `${existing.type}:${existing.workflowRunId ?? ""}:${existing.stepId ?? ""}:${existing.issueId ?? ""}` === key)) return;
      recommendations.push(recommendation);
    };

    for (const issue of missionIssues) {
      if (issue.id === oversightIssue.id) continue;
      const ageMs = now.getTime() - issue.createdAt.getTime();
      const label = issue.identifier ?? issue.id;
      const runCount = heartbeatCountByIssueId.get(issue.id) ?? 0;
      const comments = commentsByIssueId.get(issue.id) ?? [];
      const stepRowsForIssue = stepRowsByIssueId.get(issue.id) ?? [];
      const hasCheckoutOrExecution = Boolean(issue.checkoutRunId || issue.executionRunId || issue.startedAt || runCount > 0);
      const isStaleQueueStatus = issue.status === "todo" || issue.status === "backlog";

      if (isStaleQueueStatus && ageMs >= staleAfterMs && !hasCheckoutOrExecution) {
        findings.push(`stale_todo: ${label} ${issue.status} with no checkout/execution/heartbeat run_count=${runCount} — ${issue.title}`);
      }
      if (isStaleQueueStatus && stepRowsForIssue.some((row) => row.stepRun.status === "pending") && runCount === 0 && ageMs >= staleAfterMs) {
        findings.push(`dispatch_omission: ${label} workflow step linked but heartbeat run_count=0 — ${issue.title}`);
      }
      if (issue.status === "blocked") {
        const body = comments.join("\n").toLowerCase();
        const hasReplanSignal = body.includes("replan") || body.includes("re-plan") || body.includes("recover") || body.includes("escalat") || body.includes("impossible") || body.includes("blocked_without_replan");
        if (!hasReplanSignal) {
          findings.push(`blocked_without_replan: ${label} blocked without recovery/replan/escalation comment — ${issue.title}`);
          addRecommendation({ type: "request_replan", missionId: mission.id, issueId: issue.id, reason: `Blocked issue ${label} needs recovery/replan evidence`, safeToAutoApply: false });
          addRecommendation({ type: "escalate_blocked", missionId: mission.id, issueId: issue.id, reason: `Blocked issue ${label} needs owner escalation or impossible-completion report`, safeToAutoApply: false });
        }
      }
    }

    const stepRowsByRunId = new Map<string, typeof stepRows>();
    for (const row of stepRows) {
      const list = stepRowsByRunId.get(row.run.id) ?? [];
      list.push(row);
      stepRowsByRunId.set(row.run.id, list);
    }
    for (const [runId, rowsForRun] of stepRowsByRunId) {
      const stepRunByStepId = new Map(rowsForRun.map((row) => [row.stepRun.stepId, row.stepRun]));
      const steps = (rowsForRun[0]?.definition.stepsJson as WorkflowStep[] | null) ?? [];
      for (const step of steps) {
        const stepRun = stepRunByStepId.get(step.id);
        if (stepRun?.issueId && stepRun.status !== "completed") {
          const stepIssue = missionIssueById.get(stepRun.issueId);
          if (stepIssue?.status === "done") {
            findings.push(`dispatch_missing_step: run=${runId} step=${step.id} linked issue done but workflow run needs safe sync`);
            addRecommendation({
              type: "dispatch_missing_step",
              missionId: mission.id,
              workflowRunId: runId,
              stepId: step.id,
              issueId: stepRun.issueId,
              reason: `Workflow step ${step.id} has a done issue; safely sync workflow state and dispatch newly-ready internal steps`,
              safeToAutoApply: true,
            });
          }
        }
        if (!stepRun || stepRun.status !== "pending" || stepRun.issueId) continue;
        const dependenciesComplete = step.dependencies.every((dependencyId) => stepRunByStepId.get(dependencyId)?.status === "completed");
        if (!dependenciesComplete) continue;
        findings.push(`dispatch_missing_step: run=${runId} step=${step.id} ready but no workflow execution issue exists`);
        addRecommendation({
          type: "dispatch_missing_step",
          missionId: mission.id,
          workflowRunId: runId,
          stepId: step.id,
          reason: `Workflow step ${step.id} is runnable but has no execution issue`,
          safeToAutoApply: true,
        });
      }
    }

    const oversightBodies = (commentsByIssueId.get(oversightIssue.id) ?? []).join("\n");
    const failedStepRows = stepRows.filter((row) => row.stepRun.status === "failed");
    for (const row of failedStepRows) {
      const marker = `workflow-failure:${row.run.id}:${row.stepRun.stepId}`;
      const stepIssueComments = row.stepRun.issueId ? (commentsByIssueId.get(row.stepRun.issueId) ?? []).join("\n") : "";
      const hasDiagnosis = oversightBodies.includes(marker)
        || stepIssueComments.toLowerCase().includes("diagnos")
        || stepIssueComments.toLowerCase().includes("root cause")
        || stepIssueComments.toLowerCase().includes("replan")
        || stepIssueComments.toLowerCase().includes("escalat");
      if (!hasDiagnosis) {
        findings.push(`failed_step_without_diagnosis: run=${row.run.id} step=${row.stepRun.stepId}`);
        addRecommendation({
          type: "retry_failed_step_if_safe",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          reason: `Failed workflow step ${row.stepRun.stepId} needs owner diagnosis before any retry`,
          safeToAutoApply: false,
        });
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          reason: `Failed workflow step ${row.stepRun.stepId} needs recovery/replan path signal`,
          safeToAutoApply: false,
        });
      }
    }

    const uniqueFindings = Array.from(new Set(findings));
    const appliedActions: MissionOwnerSupervisionAppliedAction[] = [];
    const safeDispatchRecommendations = recommendations.filter((recommendation) => recommendation.type === "dispatch_missing_step" && recommendation.safeToAutoApply && recommendation.workflowRunId);
    if (input.applySafeActions && safeDispatchRecommendations.length > 0) {
      const stepIdsByRunId = new Map<string, string[]>();
      for (const recommendation of safeDispatchRecommendations) {
        const runId = recommendation.workflowRunId!;
        const list = stepIdsByRunId.get(runId) ?? [];
        if (recommendation.stepId) list.push(recommendation.stepId);
        stepIdsByRunId.set(runId, list);
      }
      for (const [runId, stepIds] of stepIdsByRunId) {
        const result = await syncWorkflowRunState(db, runId);
        appliedActions.push({
          type: "dispatch_missing_step",
          missionId: mission.id,
          workflowRunId: runId,
          stepIds,
          resultStatus: result.status,
        });
      }
    }

    if (uniqueFindings.length === 0) {
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, commented: false };
    }

    const findingsSignature = createHash("sha256")
      .update(uniqueFindings.slice().sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    const markerText = `mission-owner-supervision:${mission.id}:${now.toISOString().slice(0, 13)}:${findingsSignature}`;
    if (oversightBodies.includes(markerText)) {
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, commented: false };
    }

    await issueService(db).addComment(
      oversightIssue.id,
      [
        "### Mission owner supervision diagnosis",
        `<!-- ${markerText} -->`,
        `- Mission: ${mission.title}`,
        `- Observed at: ${now.toISOString()}`,
        "- Mode: decision alignment observation; this is not a hard block or RPA gate.",
        "",
        "Findings:",
        ...uniqueFindings.map((finding) => `- ${finding}`),
        "",
        "Recommended owner actions:",
        ...(recommendations.length > 0
          ? recommendations.map((recommendation) => `- ${recommendation.type}${recommendation.safeToAutoApply ? " (safe internal auto-apply candidate)" : " (owner decision required)"}: ${recommendation.reason}`)
          : ["- None"]),
        "",
        "Applied safe actions:",
        ...(appliedActions.length > 0
          ? appliedActions.map((action) => `- ${action.type}: run=${action.workflowRunId} steps=${action.stepIds.join(",") || "n/a"} result=${action.resultStatus}`)
          : ["- None"]),
        "",
        "Main executor action:",
        "- Decide whether to dispatch/retry, recover, replan, escalate, or report impossible completion with evidence.",
        "- If the path changes, use this as a future replan path signal; no replan artifact is generated by this observation yet.",
      ].join("\n"),
      { agentId: mission.ownerAgentId },
    );

    return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, commented: true };
  }

  async function runActiveMissionOwnerSupervision(input: {
    companyId?: string;
    missionIds?: string[];
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
  } = {}): Promise<ActiveMissionOwnerSupervisionResult> {
    const filters = [
      eq(missions.status, "active"),
      inArray(workflowRuns.status, ["pending", "running"]),
    ];
    if (input.companyId) filters.push(eq(missions.companyId, input.companyId));
    if (input.missionIds && input.missionIds.length > 0) filters.push(inArray(missions.id, input.missionIds));

    const rows = await db
      .select({ missionId: missions.id })
      .from(missions)
      .innerJoin(workflowRuns, eq(workflowRuns.missionId, missions.id))
      .where(and(...filters))
      .orderBy(asc(missions.createdAt), asc(missions.id));

    const missionIds = Array.from(new Set(rows.map((row) => row.missionId)));
    const results: MissionOwnerSupervisionResult[] = [];
    for (const missionId of missionIds) {
      results.push(await runMainExecutorSupervision({
        missionId,
        staleAfterMinutes: input.staleAfterMinutes,
        now: input.now,
        applySafeActions: input.applySafeActions,
      }));
    }

    return { companyId: input.companyId, missionIds, missions: results };
  }
  /**
   * Create a new mission.
   */
  async function create(input: CreateMissionInput): Promise<MissionDetail> {
    if (input.status) validateStatus(input.status);

    // Verify owner agent exists
    const [ownerRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.ownerAgentId))
      .limit(1);
    if (!ownerRow) throw notFound(`Agent not found: ${input.ownerAgentId}`);

    if ((input.source ?? "manual") === "workflow" && (input.status ?? "planning") === "active") {
      const existingActiveWorkflowMission = await db
        .select({ id: missions.id })
        .from(missions)
        .where(and(
          eq(missions.companyId, input.companyId),
          eq(missions.title, input.title),
          input.description == null ? isNull(missions.description) : eq(missions.description, input.description),
          eq(missions.status, "active"),
        ))
        .orderBy(asc(missions.createdAt), asc(missions.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingActiveWorkflowMission) {
        return getById(existingActiveWorkflowMission.id);
      }
    }

    // Create mission
    const [mission] = await db
      .insert(missions)
      .values({
        companyId: input.companyId,
        ownerAgentId: input.ownerAgentId,
        title: input.title,
        description: input.description ?? null,
        goalId: input.goalId ?? null,
        status: input.status ?? "planning",
      })
      .returning();

    // Add owner as the initial executor in mission_agents. Mission ownership is
    // tracked on missions.ownerAgentId; mission_agents.role is constrained to
    // executor/reviewer/observer by the database.
    await db.insert(missionAgents).values({
      missionId: mission.id,
      agentId: input.ownerAgentId,
      role: "executor",
    });

    // Add additional agents if provided
    if (input.agentIds && input.agentIds.length > 0) {
      for (const { agentId, role } of input.agentIds) {
        validateRole(role ?? "executor");
        // Don't add owner again
        if (agentId === input.ownerAgentId) continue;
        await db.insert(missionAgents).values({
          missionId: mission.id,
          agentId,
          role: role ?? "executor",
        }).onConflictDoNothing();
      }
    }

    if ((input.source ?? "manual") === "manual") {
      const planningIssue = await ensureMainExecutorPlanningIssue(mission);
      await missionPlanArtifactService(db).createInitialMissionPlan({
        companyId: mission.companyId,
        missionId: mission.id,
        refs: planningIssue?.id ? { planningIssueId: planningIssue.id } : {},
      });
    }

    return getById(mission.id);
  }

  /**
   * Get a mission by ID with full detail.
   */
  async function getById(id: string): Promise<MissionDetail> {
    assertMissionId(id);

    let [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, id))
      .limit(1);

    if (!mission) throw notFound(`Mission not found: ${id}`);
    mission = await reconcileMissionStatusFromWorkflowRuns(mission);

    const agentRows = await db
      .select({
        row: missionAgents,
        agentName: agents.name,
      })
      .from(missionAgents)
      .leftJoin(agents, eq(missionAgents.agentId, agents.id))
      .where(eq(missionAgents.missionId, id));

    const [ownerRow] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, mission.ownerAgentId))
      .limit(1);
    const sessionBindings = await db
      .select({
        agentId: missionSessions.agentId,
        adapterType: missionSessions.adapterType,
        status: missionSessions.status,
        lastActiveAt: missionSessions.lastActiveAt,
        runCount: missionSessions.runCount,
      })
      .from(missionSessions)
      .where(eq(missionSessions.missionId, id))
      .orderBy(desc(missionSessions.lastActiveAt), asc(missionSessions.agentId));

    return {
      ...mission,
      agents: agentRows.map((r: { row: typeof missionAgents.$inferSelect; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined })),
      ownerAgentName: ownerRow?.name,
      sessionBindings,
    };
  }

  /**
   * List missions with optional filters.
   */
  async function list(filter: ListMissionsFilter): Promise<MissionRow[]> {
    const conditions: ReturnType<typeof eq>[] = [eq(missions.companyId, filter.companyId)];

    if (filter.status) {
      validateStatus(filter.status);
      conditions.push(eq(missions.status, filter.status));
    }
    if (filter.ownerAgentId) conditions.push(eq(missions.ownerAgentId, filter.ownerAgentId));
    if (filter.goalId) conditions.push(eq(missions.goalId, filter.goalId));
    if (filter.from) conditions.push(gte(missions.createdAt, parseMissionDateFilter(filter.from, "start")));
    if (filter.to) conditions.push(lte(missions.createdAt, parseMissionDateFilter(filter.to, "end")));

    const sortColumn =
      filter.sortBy === "title"
        ? missions.title
        : filter.sortBy === "status"
          ? missions.status
          : filter.sortBy === "updatedAt"
            ? missions.updatedAt
            : missions.createdAt;

    const order = filter.sortOrder === "desc" ? desc(sortColumn) : asc(sortColumn);

    let rows: MissionRow[];
    if (filter.limit !== undefined && filter.offset !== undefined) {
      rows = await db
        .select()
        .from(missions)
        .where(and(...conditions))
        .orderBy(order)
        .limit(filter.limit)
        .offset(filter.offset);
    } else if (filter.limit !== undefined) {
      rows = await db
        .select()
        .from(missions)
        .where(and(...conditions))
        .orderBy(order)
        .limit(filter.limit);
    } else if (filter.offset !== undefined) {
      rows = await db
        .select()
        .from(missions)
        .where(and(...conditions))
        .orderBy(order)
        .offset(filter.offset);
    } else {
      rows = await db
        .select()
        .from(missions)
        .where(and(...conditions))
        .orderBy(order);
    }

    const reconciledRows = await Promise.all(rows.map((mission) => reconcileMissionStatusFromWorkflowRuns(mission)));
    return filter.status ? reconciledRows.filter((mission) => mission.status === filter.status) : reconciledRows;
  }

  /**
   * Update a mission.
   */
  async function update(id: string, input: UpdateMissionInput): Promise<MissionDetail> {
    if (input.status) validateStatus(input.status);

    const [existing] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, id))
      .limit(1);
    if (!existing) throw notFound(`Mission not found: ${id}`);

    const updates: Partial<MissionRow> = { updatedAt: new Date() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description ?? null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.goalId !== undefined) updates.goalId = input.goalId;
    if (input.startedAt !== undefined) updates.startedAt = input.startedAt;
    if (input.completedAt !== undefined) updates.completedAt = input.completedAt;

    await db
      .update(missions)
      .set(updates)
      .where(eq(missions.id, id));

    return getById(id);
  }

  /**
   * Delete a mission.
   */
  async function deleteMission(id: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, id))
      .limit(1);
    if (!existing) throw notFound(`Mission not found: ${id}`);

    await db.delete(missions).where(eq(missions.id, id));
  }

  // ---------------------------------------------------------------------------
  // Mission Agents
  // ---------------------------------------------------------------------------

  /**
   * Add an agent to a mission.
   */
  async function addAgent(input: AddMissionAgentInput): Promise<MissionAgentRow> {
    const { missionId, agentId, role = "executor" } = input;
    validateRole(role);

    // Verify mission exists
    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);

    // Verify agent exists
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) throw notFound(`Agent not found: ${agentId}`);

    const [missionAgent] = await db
      .insert(missionAgents)
      .values({
        missionId,
        agentId,
        role,
      })
      .onConflictDoUpdate({
        target: [missionAgents.missionId, missionAgents.agentId],
        set: { role },
      })
      .returning();

    return missionAgent;
  }

  /**
   * Remove an agent from a mission.
   */
  async function removeAgent(missionId: string, agentId: string): Promise<void> {
    // Can't remove owner
    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);
    if (mission.ownerAgentId === agentId) {
      throw badRequest("Cannot remove the owner agent from a mission");
    }

    await db
      .delete(missionAgents)
      .where(and(eq(missionAgents.missionId, missionId), eq(missionAgents.agentId, agentId)));
  }

  /**
   * Update an agent's role in a mission.
   */
  async function updateAgentRole(
    missionId: string,
    agentId: string,
    role: MissionAgentRole,
  ): Promise<MissionAgentRow> {
    validateRole(role);

    const [existing] = await db
      .select()
      .from(missionAgents)
      .where(and(eq(missionAgents.missionId, missionId), eq(missionAgents.agentId, agentId)))
      .limit(1);
    if (!existing) throw notFound("Agent is not a member of this mission");

    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);
    if (agentId === mission.ownerAgentId) {
      throw badRequest("Cannot change the role of the owner agent");
    }

    const [updated] = await db
      .update(missionAgents)
      .set({ role })
      .where(and(eq(missionAgents.missionId, missionId), eq(missionAgents.agentId, agentId)))
      .returning();

    return updated;
  }

  /**
   * List agents in a mission.
   */
  async function listAgents(missionId: string): Promise<MissionAgentRow[]> {
    return db
      .select()
      .from(missionAgents)
      .where(eq(missionAgents.missionId, missionId));
  }

  /**
   * Get the issue tree for a mission.
   * Returns all issues linked to this mission grouped by parent.
   */
  async function getIssueTree(missionId: string): Promise<MissionIssueTree> {
    assertMissionId(missionId);

    // Verify mission exists
    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);

    const issuesSvc = issueService(db);
    await ensureWorkflowIssuesLinkedToMission(mission);
    return issuesSvc.list(mission.companyId, { missionId });
  }

  /**
   * List workflow runs associated with a mission, including step runs and workflow names.
   */
  async function listWorkflowRuns(missionId: string): Promise<MissionWorkflowRunDetail[]> {
    assertMissionId(missionId);

    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);

    const runs = await db
      .select({
        run: workflowRuns,
        workflowName: workflowDefinitions.name,
        workflowSteps: workflowDefinitions.stepsJson,
      })
      .from(workflowRuns)
      .leftJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
      .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, missionId)))
      .orderBy(desc(workflowRuns.createdAt));

    const allStepRuns = runs.length
      ? await db
          .select()
          .from(workflowStepRuns)
          .where(inArray(workflowStepRuns.workflowRunId, runs.map((entry) => entry.run.id)))
      : [];

    const stepIssueIds = Array.from(
      new Set(
        allStepRuns
          .map((stepRun) => stepRun.issueId)
          .filter((issueId): issueId is string => Boolean(issueId)),
      ),
    );

    const stepIssues = stepIssueIds.length
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(inArray(issues.id, stepIssueIds))
      : [];

    const stepRunsMap = new Map<string, Array<typeof workflowStepRuns.$inferSelect>>();
    for (const stepRun of allStepRuns) {
      const current = stepRunsMap.get(stepRun.workflowRunId) ?? [];
      current.push(stepRun);
      stepRunsMap.set(stepRun.workflowRunId, current);
    }

    const stepIssueMap = new Map<string, MissionWorkflowStepIssue>(
      stepIssues.map((issue) => [issue.id, issue]),
    );

    const nativeDetails = runs.map(({ run, workflowName, workflowSteps }) => {
      const definitionSteps = ((workflowSteps as WorkflowStep[] | null) ?? []) as WorkflowStep[];
      const definitionStepOrder = new Map(definitionSteps.map((step, index) => [step.id, index]));
      const rawStepRuns = [...(stepRunsMap.get(run.id) ?? [])].sort((left, right) => {
        const leftIndex = definitionStepOrder.get(left.stepId) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = definitionStepOrder.get(right.stepId) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || left.stepId.localeCompare(right.stepId);
      });
      const stepRunByStepId = new Map(rawStepRuns.map((stepRun) => [stepRun.stepId, stepRun]));

      const steps: MissionWorkflowRunStep[] = definitionSteps.map((step) => {
        const stepRun = stepRunByStepId.get(step.id);
        return {
          stepId: step.id,
          name: step.name,
          agentId: step.agentId,
          dependencies: [...step.dependencies],
          description: step.description ?? null,
          toolNames: Array.isArray(step.toolNames)
            ? step.toolNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
          knowledgeBaseIds: Array.isArray(step.knowledgeBaseIds)
            ? step.knowledgeBaseIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
          status: normalizeMissionWorkflowStepStatus(stepRun?.status ?? "pending"),
          issueId: stepRun?.issueId ?? null,
          issue: stepRun?.issueId ? stepIssueMap.get(stepRun.issueId) ?? null : null,
          startedAt: stepRun?.startedAt ?? null,
          completedAt: stepRun?.completedAt ?? null,
        };
      });

      const knownStepIds = new Set(definitionSteps.map((step) => step.id));
      for (const stepRun of rawStepRuns) {
        if (knownStepIds.has(stepRun.stepId)) continue;
        steps.push({
          stepId: stepRun.stepId,
          name: stepRun.stepId,
          agentId: "",
          dependencies: [],
          description: null,
          toolNames: [],
          knowledgeBaseIds: [],
          status: normalizeMissionWorkflowStepStatus(stepRun.status),
          issueId: stepRun.issueId,
          issue: stepRun.issueId ? stepIssueMap.get(stepRun.issueId) ?? null : null,
          startedAt: stepRun.startedAt,
          completedAt: stepRun.completedAt,
        });
      }

      return {
        ...run,
        workflowName: workflowName ?? null,
        stepRuns: rawStepRuns,
        steps,
        progress: buildWorkflowRunProgress(steps),
      };
    });

    const pluginRunEntities = (await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, mission.companyId),
      )))
      .filter((entity) => {
        const data = entity.data as PluginWorkflowRunData;
        return data.companyId === mission.companyId && data.missionId === missionId;
      });

    if (pluginRunEntities.length === 0) return nativeDetails;

    const pluginWorkflowIds = Array.from(
      new Set(pluginRunEntities.map((entity) => asTrimmedString((entity.data as PluginWorkflowRunData).workflowId)).filter((id): id is string => Boolean(id))),
    );
    const pluginRunIds = pluginRunEntities.map((entity) => entity.id);

    const pluginDefinitionEntities = pluginWorkflowIds.length
      ? await db
          .select()
          .from(pluginEntities)
          .where(and(
            eq(pluginEntities.entityType, "workflow-definition"),
            eq(pluginEntities.scopeKind, "company"),
            eq(pluginEntities.scopeId, mission.companyId),
            inArray(pluginEntities.id, pluginWorkflowIds),
          ))
      : [];

    const pluginStepRunEntities = await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-step-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, mission.companyId),
      ));
    const pluginStepRuns = pluginStepRunEntities.filter((entity) => {
      const data = entity.data as PluginWorkflowStepRunData;
      const runId = asTrimmedString(data.runId);
      return runId !== null && pluginRunIds.includes(runId);
    });

    const pluginIssueIds = Array.from(
      new Set(pluginStepRuns.map((entity) => asTrimmedString((entity.data as PluginWorkflowStepRunData).issueId)).filter((id): id is string => Boolean(id))),
    );
    const pluginIssues = pluginIssueIds.length
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(inArray(issues.id, pluginIssueIds))
      : [];
    const pluginIssueMap = new Map<string, MissionWorkflowStepIssue>(pluginIssues.map((issue) => [issue.id, issue]));

    const companyAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, mission.companyId));
    const agentIdByName = new Map(companyAgents.map((agent) => [agent.name, agent.id]));

    const pluginDefinitionMap = new Map(pluginDefinitionEntities.map((entity) => [entity.id, entity]));
    const pluginStepRunsMap = new Map<string, typeof pluginStepRuns>();
    for (const stepRun of pluginStepRuns) {
      const runId = asTrimmedString((stepRun.data as PluginWorkflowStepRunData).runId);
      if (!runId) continue;
      const current = pluginStepRunsMap.get(runId) ?? [];
      current.push(stepRun);
      pluginStepRunsMap.set(runId, current);
    }

    const pluginDetails: MissionWorkflowRunDetail[] = pluginRunEntities.map((entity) => {
      const runData = entity.data as PluginWorkflowRunData;
      const workflowId = asTrimmedString(runData.workflowId) ?? "";
      const definitionData = (pluginDefinitionMap.get(workflowId)?.data ?? {}) as PluginWorkflowDefinitionData;
      const definitionSteps = Array.isArray(definitionData.steps)
        ? definitionData.steps.map(toPluginWorkflowStepData).filter((step): step is PluginWorkflowStepData => Boolean(step))
        : [];
      const definitionStepOrder = new Map(definitionSteps.map((step, index) => [asTrimmedString(step.id) ?? "", index]));
      const rawStepRuns = [...(pluginStepRunsMap.get(entity.id) ?? [])].sort((left, right) => {
        const leftData = left.data as PluginWorkflowStepRunData;
        const rightData = right.data as PluginWorkflowStepRunData;
        const leftStepId = asTrimmedString(leftData.stepId) ?? "";
        const rightStepId = asTrimmedString(rightData.stepId) ?? "";
        const leftIndex = definitionStepOrder.get(leftStepId) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = definitionStepOrder.get(rightStepId) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || leftStepId.localeCompare(rightStepId);
      });
      const rawStepRunRows = rawStepRuns.map((stepRun) => {
        const data = stepRun.data as PluginWorkflowStepRunData;
        return {
          id: stepRun.id,
          workflowRunId: entity.id,
          stepId: asTrimmedString(data.stepId) ?? stepRun.title ?? stepRun.id,
          issueId: asTrimmedString(data.issueId),
          status: normalizePluginWorkflowStepStatus(data.status),
          startedAt: parsePluginDate(data.startedAt),
          completedAt: parsePluginDate(data.completedAt),
        } as typeof workflowStepRuns.$inferSelect;
      });
      const stepRunByStepId = new Map(rawStepRunRows.map((stepRun) => [stepRun.stepId, stepRun]));

      const steps: MissionWorkflowRunStep[] = definitionSteps.map((step) => {
        const stepId = asTrimmedString(step.id) ?? "";
        const stepRun = stepRunByStepId.get(stepId);
        const agentName = asTrimmedString(step.agentName) ?? asTrimmedString(step.agent) ?? asTrimmedString(step.assigneeAgentName);
        const agentId = asTrimmedString(step.agentId) ?? (agentName ? agentIdByName.get(agentName) : undefined) ?? "";
        return {
          stepId,
          name: asTrimmedString(step.name) ?? asTrimmedString(step.title) ?? stepId,
          agentId,
          dependencies: asStringArray(step.dependencies).length ? asStringArray(step.dependencies) : asStringArray(step.dependsOn),
          description: asTrimmedString(step.description),
          toolNames: asStringArray(step.toolNames),
          knowledgeBaseIds: asStringArray(step.knowledgeBaseIds),
          status: stepRun ? normalizePluginWorkflowStepStatus(stepRun.status) : "pending",
          issueId: stepRun?.issueId ?? null,
          issue: stepRun?.issueId ? pluginIssueMap.get(stepRun.issueId) ?? null : null,
          startedAt: stepRun?.startedAt ?? null,
          completedAt: stepRun?.completedAt ?? null,
        };
      });

      const knownStepIds = new Set(definitionSteps.map((step) => asTrimmedString(step.id)).filter((id): id is string => Boolean(id)));
      for (const stepRun of rawStepRunRows) {
        if (knownStepIds.has(stepRun.stepId)) continue;
        steps.push({
          stepId: stepRun.stepId,
          name: stepRun.stepId,
          agentId: "",
          dependencies: [],
          description: null,
          toolNames: [],
          knowledgeBaseIds: [],
          status: normalizePluginWorkflowStepStatus(stepRun.status),
          issueId: stepRun.issueId,
          issue: stepRun.issueId ? pluginIssueMap.get(stepRun.issueId) ?? null : null,
          startedAt: stepRun.startedAt,
          completedAt: stepRun.completedAt,
        });
      }

      const run = {
        id: entity.id,
        workflowId,
        companyId: mission.companyId,
        missionId,
        status: asTrimmedString(runData.status) ?? entity.status ?? "pending",
        triggeredBy: asTrimmedString(runData.triggerSource) ?? "plugin",
        startedAt: parsePluginDate(runData.startedAt),
        completedAt: parsePluginDate(runData.completedAt),
        createdAt: entity.createdAt,
      } as typeof workflowRuns.$inferSelect;

      return {
        ...run,
        workflowName: asTrimmedString(runData.workflowName) ?? asTrimmedString(definitionData.name),
        stepRuns: rawStepRunRows,
        steps,
        progress: buildWorkflowRunProgress(steps),
      };
    });

    return [...nativeDetails, ...pluginDetails].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  return {
    create,
    getById,
    list,
    update,
    delete: deleteMission,
    addAgent,
    removeAgent,
    updateAgentRole,
    listAgents,
    getIssueTree,
    listWorkflowRuns,
    ensureMainExecutorOversightIssue,
    runMainExecutorSupervision,
    runActiveMissionOwnerSupervision,
  };
}

export type MissionService = ReturnType<typeof missionService>;
