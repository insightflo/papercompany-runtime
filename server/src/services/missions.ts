/**
 * Mission Service
 *
 * CRUD operations for missions and mission_agents.
 * OQ-4 schema: owner_agent_id is the mission main executor; mission_agents carries executor/reviewer/observer roles.
 */

import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { mergeMissionPlanRefs, missionPlanArtifactService, summarizeMissionPlanForRuntime, type MissionPlanRuntimeSummary } from "./mission-plan-artifacts.js";
import {
  isTerminalFailureStatus,
  listMissionExecutionSourceSnapshots,
  type MissionExecutionStatus,
  type MissionExecutionSourceRef,
  type MissionExecutionUnit,
} from "./missions/mission-execution-sources.js";
import { buildMissionRuleContext } from "./missions/mission-rule-context.js";
import { buildMissionSupervisionContext } from "./missions/mission-supervision-context.js";
import type { MissionGovernanceThreadSummary } from "./missions/governance-thread.js";
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

type IssueRow = typeof issues.$inferSelect;

export type MissionOwnerDecisionOption =
  | "request_input"
  | "retry_source_issue"
  | "reassign_source_issue"
  | "replan_mission"
  | "escalate"
  | "report_impossible"
  | "recover_artifact"
  | "no_action_waiting";

export const MISSION_OWNER_DECISION_OPTIONS: MissionOwnerDecisionOption[] = [
  "request_input",
  "retry_source_issue",
  "reassign_source_issue",
  "replan_mission",
  "escalate",
  "report_impossible",
  "recover_artifact",
  "no_action_waiting",
];

function buildMissionOwnerActionMarker(input: {
  missionId: string;
  sourceIssueId: string;
  actionType: "unblock";
  status: "decision_required";
}): string {
  return `<!-- mission-owner-action:${JSON.stringify({
    missionId: input.missionId,
    sourceIssueId: input.sourceIssueId,
    actionType: input.actionType,
    status: input.status,
  })} -->`;
}

function buildMissionOwnerDecisionFormat(): string {
  return [
    "Required output format:",
    "### Mission owner decision",
    "Decision: <one of the allowed decision options>",
    "Source issue: <source issue identifier or id>",
    "Reason: <why this decision is appropriate>",
    "Next action: <specific next action or waiting condition>",
    "Evidence: <compact evidence used for the decision>",
  ].join("\n");
}

export type ExtractedMissionOwnerDecision = {
  decision: MissionOwnerDecisionOption;
  sourceIssueRef?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
} | {
  decision: null;
  invalidDecision: string;
  sourceIssueRef?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
};

const MISSION_OWNER_DECISION_BLOCK_HEADING = "### Mission owner decision";

function firstNonEmptyLine(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function readDecisionField(block: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedField}\\s*:\\s*([\\s\\S]*?)(?=^\\w[\\w ]*\\s*:|^###\\s+|(?![\\s\\S]))`, "im");
  return firstNonEmptyLine(pattern.exec(block)?.[1]);
}

export function extractMissionOwnerDecisionFromText(text: string): ExtractedMissionOwnerDecision | null {
  const headingIndex = text.toLowerCase().lastIndexOf(MISSION_OWNER_DECISION_BLOCK_HEADING.toLowerCase());
  if (headingIndex < 0) return null;

  const blockStart = headingIndex + MISSION_OWNER_DECISION_BLOCK_HEADING.length;
  const rest = text.slice(blockStart);
  const nextHeading = rest.search(/^###\s+/m);
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const rawDecision = readDecisionField(block, "Decision")?.toLowerCase();
  if (!rawDecision) return null;

  const sourceIssueRef = readDecisionField(block, "Source issue");
  const reason = readDecisionField(block, "Reason");
  const nextAction = readDecisionField(block, "Next action");
  const evidence = readDecisionField(block, "Evidence");

  if (!MISSION_OWNER_DECISION_OPTIONS.includes(rawDecision as MissionOwnerDecisionOption)) {
    return { decision: null, invalidDecision: rawDecision, sourceIssueRef, reason, nextAction, evidence };
  }

  return { decision: rawDecision as MissionOwnerDecisionOption, sourceIssueRef, reason, nextAction, evidence };
}

function extractLatestMissionOwnerDecision(texts: string[]): ExtractedMissionOwnerDecision | null {
  for (const text of texts.slice().reverse()) {
    const decision = extractMissionOwnerDecisionFromText(text);
    if (decision) return decision;
  }
  return null;
}

function buildMissionOwnerUnblockDescription(mission: MissionRow, blockedIssue: IssueRow): string {
  const sourceLabel = blockedIssue.identifier ?? blockedIssue.id;
  return [
    buildMissionOwnerActionMarker({
      missionId: mission.id,
      sourceIssueId: blockedIssue.id,
      actionType: "unblock",
      status: "decision_required",
    }),
    "Resolve the mission-level blocker without taking over the delegated execution issue.",
    "",
    `Mission id: ${mission.id}`,
    `Mission title: ${mission.title}`,
    `Source issue id: ${blockedIssue.id}`,
    `Source issue identifier: ${sourceLabel}`,
    `Source issue title: ${blockedIssue.title}`,
    `Source issue status: ${blockedIssue.status}`,
    `Original assignee agent: ${blockedIssue.assigneeAgentId ?? "unassigned"}`,
    "",
    "Mission owner duties:",
    "- Manage the mission outcome boundary: diagnose blockers, decide recovery direction, and keep the mission moving.",
    "- Do not perform the delegated source work by default; coordinate, decide, and record the next owner action.",
    "- Preserve the source issue assignee unless an explicit reassignment decision is made.",
    "- Use Governance Thread information only as read-only evidence for this owner decision.",
    "",
    "Allowed decision options:",
    ...MISSION_OWNER_DECISION_OPTIONS.map((decision) => `- ${decision}`),
    "",
    buildMissionOwnerDecisionFormat(),
    "",
    "Source issue remains assigned to the original executor unless this comment explicitly chooses reassign_source_issue.",
    "Governance evidence: latest evidence unavailable for this owner action template.",
  ].join("\n");
}

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
  activeMissionPlan: MissionPlanRuntimeSummary;
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
  | "dispatch_missing_unit"
  | "retry_failed_step_if_safe"
  | "retry_unit_if_safe"
  | "request_replan"
  | "request_approval"
  | "escalate_blocked"
  | "materialize_artifact_from_comment"
  | "mark_impossible_with_evidence";

export type MissionOwnerSupervisionRecommendation = {
  type: MissionOwnerSupervisionRecommendationType;
  missionId: string;
  reason: string;
  safeToAutoApply: boolean;
  workflowRunId?: string;
  stepId?: string;
  issueId?: string;
  sourceRef?: MissionExecutionSourceRef;
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

type GovernanceSummaryEvent = MissionGovernanceThreadSummary["latestEvents"][number];

const GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT = 5;

function formatGovernanceEventSummary(event: GovernanceSummaryEvent): string {
  const source = `${event.sourceRef.type}:${event.sourceRef.id}`;
  return `${event.eventType}: ${event.title} — ${event.summary} [${source}]`;
}

function governanceThreadReasonSuffix(summary: MissionGovernanceThreadSummary | null | undefined): string | null {
  if (!summary || summary.totalEventCount === 0) return null;
  const decisionEvent = summary.openDecisions[0];
  const failedOrBlockedEvent = [...summary.latestEvents]
    .reverse()
    .find((event) => event.severity === "failed" || event.severity === "blocked" || event.severity === "attention");
  const event = decisionEvent ?? failedOrBlockedEvent ?? summary.latestEvents.at(-1);
  if (!event) return `governance thread observed ${summary.totalEventCount} event(s)`;
  return `${event.eventType}: ${event.summary}`;
}

function formatGovernanceThreadEvidenceLines(summary: MissionGovernanceThreadSummary | null | undefined): string[] {
  if (!summary || summary.totalEventCount === 0) return [];
  const latestEventLines = summary.latestEvents
    .slice(-GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT)
    .map((event) => `- ${formatGovernanceEventSummary(event)}`);
  const openDecisionLines = summary.openDecisions.length > 0
    ? [
      "- Open decisions:",
      ...summary.openDecisions
        .slice(0, GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT)
        .map((event) => `  - ${formatGovernanceEventSummary(event)}`),
    ]
    : [];
  return [
    "Governance thread evidence:",
    `- Total governance events observed: ${summary.totalEventCount}`,
    ...latestEventLines,
    ...openDecisionLines,
  ];
}

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

export type MissionOwnerActionCreatedHandler = (input: {
  mission: MissionRow;
  issue: typeof issues.$inferSelect;
  sourceIssue: typeof issues.$inferSelect;
}) => Promise<unknown> | unknown;

export interface MissionServiceDeps {
  onOwnerActionCreated?: MissionOwnerActionCreatedHandler;
}

export function missionService(db: Db, deps: MissionServiceDeps = {}) {
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
    metadata: { workflowStepIds?: string[]; sourceRunId?: string; executionUnits?: Array<Record<string, unknown>> } = {},
  ): Promise<void> {
    const executionUnits = metadata.executionUnits ?? [
      ...(metadata.sourceRunId ? [{
        kind: "native_workflow_run",
        title: workflowName,
        status: "running",
        sourceRef: { type: "native_workflow_run", id: metadata.sourceRunId },
      }] : []),
      ...(metadata.workflowStepIds ?? []).map((stepId) => ({
        kind: "native_workflow_step_run",
        title: stepId,
        status: "pending",
        sourceRef: {
          type: "native_workflow_step_run",
          id: stepId,
          ...(metadata.sourceRunId ? { workflowRunId: metadata.sourceRunId } : {}),
        },
      })),
    ];
    const missionRuleContext = await buildMissionRuleContext(db, { companyId: mission.companyId });
    const refs = mergeMissionPlanRefs({}, {
      oversightIssueId: oversightIssue.id,
      workflowName,
      ...(metadata.workflowStepIds ? { workflowStepIds: metadata.workflowStepIds } : {}),
      ...(metadata.sourceRunId ? { sourceRunId: metadata.sourceRunId } : {}),
      ...(executionUnits.length > 0 ? { executionUnits } : {}),
      ...(missionRuleContext.ruleRefs.length > 0 ? { ruleRefs: missionRuleContext.ruleRefs } : {}),
    });
    const planSvc = missionPlanArtifactService(db);
    const activePlan = await planSvc.getActiveMissionPlan({ companyId: mission.companyId, missionId: mission.id });
    if (activePlan) {
      const mergedRefs = mergeMissionPlanRefs(activePlan.refs, refs);
      const currentRefs = typeof activePlan.refs === "object" && activePlan.refs !== null && !Array.isArray(activePlan.refs)
        ? activePlan.refs as Record<string, unknown>
        : {};
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

  async function ensureMainExecutorUnblockIssue(
    mission: MissionRow,
    blockedIssue: typeof issues.$inferSelect,
  ): Promise<typeof issues.$inferSelect> {
    const existing = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, blockedIssue.id),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const blockedLabel = blockedIssue.identifier ?? blockedIssue.id;
    const unblockIssue = await issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: buildMissionOwnerUnblockDescription(mission, blockedIssue),
      missionId: mission.id,
      originKind: "mission_main_executor_unblock",
      originId: blockedIssue.id,
      priority: "high",
      status: "todo",
      title: `[Unblock] ${blockedLabel}: ${blockedIssue.title}`,
    });

    if (deps.onOwnerActionCreated) {
      void Promise.resolve(deps.onOwnerActionCreated({
        mission,
        issue: unblockIssue,
        sourceIssue: blockedIssue,
      })).catch((err) => {
        logger.warn({ err, missionId: mission.id, issueId: unblockIssue.id }, "failed to notify owner about mission unblock action");
      });
    }

    return unblockIssue;
  }

  async function ensureMainExecutorOversightIssue(
    mission: MissionRow,
    workflowName: string,
    metadata: { workflowStepIds?: string[]; sourceRunId?: string; executionUnits?: Array<Record<string, unknown>> } = {},
  ): Promise<typeof issues.$inferSelect> {
    const existing = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (existing) {
      const nextTitle = `[Oversight] ${workflowName}`;
      if (existing.title !== nextTitle) {
        await db
          .update(issues)
          .set({ title: nextTitle, updatedAt: new Date() })
          .where(eq(issues.id, existing.id));
        existing.title = nextTitle;
      }
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

  async function ensureMissionExecutionPlan(input: {
    companyId: string;
    missionId: string;
    sourceHints?: {
      workflowName?: string;
      sourceRunId?: string;
      workflowStepIds?: string[];
      executionUnits?: Array<Record<string, unknown>>;
    };
  }): Promise<{ missionId: string; oversightIssueId: string; planId: string | null }> {
    const [mission] = await db
      .select()
      .from(missions)
      .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
      .limit(1);
    if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

    const snapshot = await listMissionExecutionSourceSnapshots(db, {
      companyId: input.companyId,
      missionIds: [input.missionId],
    }).then((snapshots) => snapshots[input.missionId] ?? null);
    const snapshotUnits = snapshot?.units.map((unit) => ({
      kind: unit.kind,
      title: unit.title ?? unit.workflowName ?? null,
      status: unit.status,
      sourceRef: unit.sourceRef,
    })) ?? [];
    const executionUnits = input.sourceHints?.executionUnits ?? snapshotUnits;
    const workflowName = input.sourceHints?.workflowName
      ?? snapshot?.units.find((unit) => unit.workflowName)?.workflowName
      ?? snapshot?.units.find((unit) => unit.title)?.title
      ?? "Mission execution";

    const oversightIssue = await ensureMainExecutorOversightIssue(mission, workflowName, {
      workflowStepIds: input.sourceHints?.workflowStepIds,
      sourceRunId: input.sourceHints?.sourceRunId,
      executionUnits,
    });
    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({
      companyId: input.companyId,
      missionId: input.missionId,
    });
    return { missionId: mission.id, oversightIssueId: oversightIssue.id, planId: activePlan?.id ?? null };
  }

  type JsonRecord = Record<string, unknown>;

  function asRecord(value: unknown): JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
  }

  function asRecordArray(value: unknown): JsonRecord[] {
    return Array.isArray(value)
      ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item))
      : [];
  }

  function trimmedString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function normalizedPlanStatus(value: unknown): string {
    return trimmedString(value)?.toLowerCase() ?? "";
  }

  function executionUnitKeyFromSourceRef(sourceRef: unknown): string | null {
    const ref = asRecord(sourceRef);
    const type = trimmedString(ref.type);
    const id = trimmedString(ref.id);
    return type && id ? `${type}:${id}` : null;
  }

  function executionUnitKey(unit: Pick<MissionExecutionUnit, "sourceRef">): string {
    return `${unit.sourceRef.type}:${unit.sourceRef.id}`;
  }

  function textContainsAny(value: unknown, needles: string[]): boolean {
    const text = JSON.stringify(value ?? "").toLowerCase();
    return needles.some((needle) => text.includes(needle));
  }

  function unitRequiresGovernedAction(unit: JsonRecord): boolean {
    return textContainsAny(unit, ["external", "cost", "legal", "destructive", "delete", "spend", "payment", "production"]);
  }

  function isApprovalRuleMode(mode: unknown): boolean {
    const normalized = normalizedPlanStatus(mode);
    return normalized === "approval_gate" || normalized === "hard_gate";
  }

  function hasDiagnosisSignal(...bodies: string[]): boolean {
    const body = bodies.join("\n").toLowerCase();
    return body.includes("diagnos")
      || body.includes("root cause")
      || body.includes("replan")
      || body.includes("re-plan")
      || body.includes("recover")
      || body.includes("escalat")
      || body.includes("impossible")
      || body.includes("failure:")
      || body.includes("failed_unit_without_diagnosis");
  }

  function hasArtifactMissingSignal(...bodies: string[]): boolean {
    const body = bodies.join("\n").toLowerCase();
    return body.includes("required workflow artifact missing")
      || body.includes("required source artifact is missing")
      || body.includes("artifact missing")
      || body.includes("블로그 파일 누락")
      || body.includes("markdown 파일로 저장")
      || body.includes("파일로만 저장");
  }

  function hasRecoverableArtifactComment(...bodies: string[]): boolean {
    const body = bodies.join("\n");
    const lower = body.toLowerCase();
    return hasArtifactMissingSignal(body)
      && (lower.includes(".md") || lower.includes("markdown"))
      && /^#{1,3}\s+\S+/m.test(body);
  }

  async function listRecurringArtifactMissingIssueRefs(input: {
    companyId: string;
    assigneeAgentId: string | null;
    since: Date;
  }): Promise<Array<{ id: string; identifier: string | null; title: string }>> {
    if (!input.assigneeAgentId) return [];
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .innerJoin(issueComments, eq(issueComments.issueId, issues.id))
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.assigneeAgentId),
        isNull(issues.hiddenAt),
        gte(issueComments.createdAt, input.since),
        sql`(
          ${issueComments.body} ilike '%required workflow artifact missing%'
          or ${issueComments.body} ilike '%artifact missing%'
          or ${issueComments.body} ilike '%블로그 파일 누락%'
          or ${issueComments.body} ilike '%markdown 파일로 저장%'
          or ${issueComments.body} ilike '%파일로만 저장%'
        )`,
      ));
    const byIssueId = new Map<string, { id: string; identifier: string | null; title: string }>();
    for (const row of rows) byIssueId.set(row.id, row);
    return [...byIssueId.values()];
  }

  async function runMainExecutorSupervision(input: {
    missionId: string;
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
  }): Promise<MissionOwnerSupervisionResult> {
    const context = await buildMissionSupervisionContext(db, { missionId: input.missionId });
    const {
      mission,
      missionIssues,
      missionIssueById,
      commentsByIssueId,
      heartbeatCountByIssueId,
      heartbeatRunsByIssueId,
      stepRows,
      stepRowsByIssueId,
      executionSnapshot,
      governanceThread,
      activePlan,
    } = context;

    const governanceReasonSuffix = governanceThreadReasonSuffix(governanceThread?.summary);
    const governanceEvidenceLines = formatGovernanceThreadEvidenceLines(governanceThread?.summary);
    const enrichRecommendationReason = (reason: string): string => governanceReasonSuffix
      ? `${reason}; governance thread: ${governanceReasonSuffix}`
      : reason;

    let oversightIssue = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (!oversightIssue) {
      await ensureMissionExecutionPlan({ companyId: mission.companyId, missionId: mission.id });
      oversightIssue = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    }
    if (!oversightIssue) {
      return { missionId: mission.id, oversightIssueId: null, findings: [], recommendations: [], appliedActions: [], commented: false };
    }

    const now = input.now ?? new Date();
    const staleAfterMs = Math.max(1, input.staleAfterMinutes ?? 120) * 60 * 1000;

    const findings: string[] = [];
    const recommendations: MissionOwnerSupervisionRecommendation[] = [];
    const addRecommendation = (recommendation: MissionOwnerSupervisionRecommendation) => {
      const sourceKey = recommendation.sourceRef ? `${recommendation.sourceRef.type}:${recommendation.sourceRef.id}` : "";
      const key = `${recommendation.type}:${recommendation.workflowRunId ?? ""}:${recommendation.stepId ?? ""}:${recommendation.issueId ?? ""}:${sourceKey}`;
      if (recommendations.some((existing) => {
        const existingSourceKey = existing.sourceRef ? `${existing.sourceRef.type}:${existing.sourceRef.id}` : "";
        return `${existing.type}:${existing.workflowRunId ?? ""}:${existing.stepId ?? ""}:${existing.issueId ?? ""}:${existingSourceKey}` === key;
      })) return;
      recommendations.push({
        ...recommendation,
        reason: enrichRecommendationReason(recommendation.reason),
      });
    };

    for (const issue of missionIssues) {
      if (issue.id === oversightIssue.id) continue;
      const ageMs = now.getTime() - issue.createdAt.getTime();
      const label = issue.identifier ?? issue.id;
      const runCount = heartbeatCountByIssueId.get(issue.id) ?? 0;
      const runsForIssue = heartbeatRunsByIssueId.get(issue.id) ?? [];
      const comments = commentsByIssueId.get(issue.id) ?? [];
      const stepRowsForIssue = stepRowsByIssueId.get(issue.id) ?? [];
      const hasActiveHeartbeat = runsForIssue.some((run) => run.status === "queued" || run.status === "running");
      const failedRunsForIssue = runsForIssue.filter((run) => run.status === "failed" || run.error || run.errorCode || run.exitCode != null);
      const hasCheckoutOrExecution = Boolean(issue.checkoutRunId || issue.executionRunId || issue.startedAt || runCount > 0);
      const isStaleQueueStatus = issue.status === "todo" || issue.status === "backlog";

      if (isStaleQueueStatus && ageMs >= staleAfterMs && !hasCheckoutOrExecution) {
        findings.push(`stale_todo: ${label} ${issue.status} with no checkout/execution/heartbeat run_count=${runCount} — ${issue.title}`);
      }
      if (isStaleQueueStatus && ageMs >= staleAfterMs && failedRunsForIssue.length > 0 && !hasActiveHeartbeat) {
        const latestFailedRun = failedRunsForIssue
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        findings.push(`stale_todo_after_failed_run: ${label} ${issue.status} has failed heartbeat run=${latestFailedRun.id} and no active execution — ${issue.title}`);
        addRecommendation({
          type: "retry_unit_if_safe",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Queued issue ${label} has a failed heartbeat run and no active execution; owner should diagnose before retry/re-dispatch`,
          safeToAutoApply: false,
        });
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Queued issue ${label} remains ${issue.status} after failed execution; owner should recover, replan, or escalate`,
          safeToAutoApply: false,
        });
      }
      if (isStaleQueueStatus && stepRowsForIssue.some((row) => row.stepRun.status === "pending") && runCount === 0 && ageMs >= staleAfterMs) {
        findings.push(`dispatch_omission: ${label} workflow step linked but heartbeat run_count=0 — ${issue.title}`);
      }
      if (issue.originKind === "mission_main_executor_unblock") {
        const ownerDecision = extractLatestMissionOwnerDecision(comments);
        if (ownerDecision?.decision === null) {
          findings.push(`owner_action_decision_invalid: ${label} has unsupported decision=${ownerDecision.invalidDecision} — ${issue.title}`);
        } else if (ownerDecision) {
          const sourceIssue = issue.originId ? missionIssueById.get(issue.originId) : null;
          const sourceLabel = sourceIssue ? (sourceIssue.identifier ?? sourceIssue.id) : (ownerDecision.sourceIssueRef ?? issue.originId ?? "unknown-source");
          findings.push(`owner_action_decision_recorded: ${label} decision=${ownerDecision.decision} source=${sourceLabel} — ${issue.title}`);
          const baseReason = ownerDecision.reason ? `Owner decision ${ownerDecision.decision} for ${sourceLabel}: ${ownerDecision.reason}` : `Owner decision ${ownerDecision.decision} recorded for ${sourceLabel}`;
          switch (ownerDecision.decision) {
            case "retry_source_issue":
              addRecommendation({
                type: "retry_unit_if_safe",
                missionId: mission.id,
                issueId: sourceIssue?.id ?? issue.originId ?? issue.id,
                reason: `${baseReason}; source issue should be re-dispatched or woken only in a later approved execution slice`,
                safeToAutoApply: false,
              });
              break;
            case "reassign_source_issue":
              addRecommendation({
                type: "request_approval",
                missionId: mission.id,
                issueId: sourceIssue?.id ?? issue.originId ?? issue.id,
                reason: `${baseReason}; source issue reassignment requires explicit approved handling in a later execution slice`,
                safeToAutoApply: false,
              });
              break;
            case "replan_mission":
              addRecommendation({
                type: "request_replan",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; mission plan revision is required before execution changes`,
                safeToAutoApply: false,
              });
              break;
            case "recover_artifact":
              addRecommendation({
                type: "materialize_artifact_from_comment",
                missionId: mission.id,
                issueId: sourceIssue?.id ?? issue.originId ?? issue.id,
                reason: `${baseReason}; artifact materialization/reconciliation is needed before retrying`,
                safeToAutoApply: false,
              });
              break;
            case "request_input":
              addRecommendation({
                type: "request_approval",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; external/operator input is needed and must not be auto-applied`,
                safeToAutoApply: false,
              });
              break;
            case "escalate":
              addRecommendation({
                type: "escalate_blocked",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; escalation should be handled explicitly by an operator or later approved slice`,
                safeToAutoApply: false,
              });
              break;
            case "report_impossible":
              addRecommendation({
                type: "mark_impossible_with_evidence",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; impossible completion report should remain read-only until an approved execution slice`,
                safeToAutoApply: false,
              });
              break;
            case "no_action_waiting":
              addRecommendation({
                type: "request_approval",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; waiting condition recorded, no automatic action should run`,
                safeToAutoApply: false,
              });
              break;
          }
        }
      }
      if (issue.status === "blocked" && issue.originKind === "mission_main_executor_unblock") {
        const sourceIssue = issue.originId ? missionIssueById.get(issue.originId) : null;
        const sourceLabel = sourceIssue ? (sourceIssue.identifier ?? sourceIssue.id) : (issue.originId ?? "unknown-source");
        const ownerActionBody = comments.join("\n");
        const sourceComments = sourceIssue ? (commentsByIssueId.get(sourceIssue.id) ?? []) : [];
        const sourceBody = sourceComments.join("\n");
        findings.push(`owner_unblock_action_blocked: ${label} is a mission owner unblock action for ${sourceLabel} but is itself blocked — ${issue.title}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Owner unblock action ${label} is self-blocked; owner should choose a recovery decision instead of blocking the recovery issue`,
          safeToAutoApply: false,
        });
        if (sourceIssue && hasRecoverableArtifactComment(sourceBody, ownerActionBody, sourceIssue.description ?? "", issue.description ?? "")) {
          findings.push(`artifact_recovery_available: ${sourceLabel} has required artifact missing signal and candidate markdown content in comments; materialize the canonical file before retrying — ${sourceIssue.title}`);
          addRecommendation({
            type: "materialize_artifact_from_comment",
            missionId: mission.id,
            issueId: sourceIssue.id,
            reason: `Required artifact for ${sourceLabel} appears recoverable from comment body; materialize the canonical markdown file, then retry/reconcile the workflow step`,
            safeToAutoApply: false,
          });
        }
      }
      if (issue.status === "blocked" && issue.originKind !== "mission_main_executor_unblock") {
        await ensureMainExecutorUnblockIssue(mission, issue);
        const body = comments.join("\n").toLowerCase();
        if (hasArtifactMissingSignal(body)) {
          const recurringIssues = await listRecurringArtifactMissingIssueRefs({
            companyId: mission.companyId,
            assigneeAgentId: issue.assigneeAgentId,
            since: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
          });
          if (recurringIssues.length >= 2) {
            const issueRefs = recurringIssues
              .map((row) => row.identifier ?? row.id)
              .sort()
              .join(", ");
            findings.push(`recurring_artifact_missing: ${label} repeats required artifact/file materialization failure for assignee across ${recurringIssues.length} recent issues (${issueRefs}) — ${issue.title}`);
            addRecommendation({
              type: "request_replan",
              missionId: mission.id,
              issueId: issue.id,
              reason: `Recurring artifact-missing failure detected for ${label}; owner should update the workflow/agent instructions and evidence contract before retrying`,
              safeToAutoApply: false,
            });
          }
        }
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
      const hasDiagnosis = oversightBodies.includes(marker) || hasDiagnosisSignal(stepIssueComments);
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
          type: "retry_unit_if_safe",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          sourceRef: {
            type: "native_workflow_run",
            id: row.run.id,
            workflowRunId: row.run.id,
            stepId: row.stepRun.stepId,
            issueId: row.stepRun.issueId ?? null,
            pluginId: null,
            externalId: null,
          },
          reason: `Failed execution unit ${row.run.id}/${row.stepRun.stepId} needs owner diagnosis before any retry`,
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

    for (const unit of executionSnapshot.units) {
      if (!(unit.kind === "plugin_workflow_run" || unit.kind === "plugin_workflow_step_run")) continue;
      if (!(unit.status === "failed" || unit.status === "timed_out")) continue;
      const marker = `unit-failure:${unit.sourceRef.type}:${unit.sourceRef.id}`;
      const linkedIssueComments = unit.issueId ? (commentsByIssueId.get(unit.issueId) ?? []).join("\n") : "";
      const hasDiagnosis = oversightBodies.includes(marker) || hasDiagnosisSignal(linkedIssueComments);
      if (hasDiagnosis) continue;
      findings.push(`failed_unit_without_diagnosis: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=${unit.status}${unit.stepId ? ` step=${unit.stepId}` : ""}`);
      addRecommendation({
        type: "retry_unit_if_safe",
        missionId: mission.id,
        workflowRunId: unit.workflowRunId ?? undefined,
        stepId: unit.stepId ?? undefined,
        issueId: unit.issueId ?? undefined,
        sourceRef: unit.sourceRef,
        reason: `Failed execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} needs owner diagnosis before retry`,
        safeToAutoApply: false,
      });
      addRecommendation({
        type: "request_replan",
        missionId: mission.id,
        workflowRunId: unit.workflowRunId ?? undefined,
        stepId: unit.stepId ?? undefined,
        issueId: unit.issueId ?? undefined,
        sourceRef: unit.sourceRef,
        reason: `Failed execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} needs recovery/replan path signal`,
        safeToAutoApply: false,
      });
    }

    for (const unit of executionSnapshot.units) {
      if (!(unit.kind === "plugin_workflow_run" || unit.kind === "plugin_workflow_step_run" || unit.kind === "native_workflow_run")) continue;
      const isActiveExecutionStatus = unit.status === "pending" || unit.status === "running";
      if (!isActiveExecutionStatus) continue;
      const lastObservedAt = unit.updatedAt ?? unit.startedAt ?? unit.createdAt;
      if (lastObservedAt && now.getTime() - lastObservedAt.getTime() >= staleAfterMs) {
        findings.push(`stale_execution_unit: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=${unit.status} stale_since=${lastObservedAt.toISOString()}${unit.stepId ? ` step=${unit.stepId}` : ""}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: unit.workflowRunId ?? undefined,
          stepId: unit.stepId ?? undefined,
          issueId: unit.issueId ?? undefined,
          sourceRef: unit.sourceRef,
          reason: `Execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} is still ${unit.status} after ${input.staleAfterMinutes ?? 120} minutes; owner should recover/replan/escalate`,
          safeToAutoApply: false,
        });
      }
      if (unit.issueId && unit.status === "running") {
        const linkedIssue = missionIssueById.get(unit.issueId);
        if (linkedIssue?.status === "blocked") {
          findings.push(`execution_issue_status_mismatch: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=running linked_issue=${linkedIssue.identifier ?? linkedIssue.id} status=blocked${unit.stepId ? ` step=${unit.stepId}` : ""}`);
          addRecommendation({
            type: "request_replan",
            missionId: mission.id,
            workflowRunId: unit.workflowRunId ?? undefined,
            stepId: unit.stepId ?? undefined,
            issueId: unit.issueId,
            sourceRef: unit.sourceRef,
            reason: `Linked issue ${linkedIssue.identifier ?? linkedIssue.id} is blocked while execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} remains running`,
            safeToAutoApply: false,
          });
        }
      }
    }

    if (activePlan) {
      for (const requiredInput of asRecordArray(activePlan.requiredInputs)) {
        const key = trimmedString(requiredInput.key) ?? trimmedString(requiredInput.title) ?? "required-input";
        if (normalizedPlanStatus(requiredInput.status) === "received") continue;
        findings.push(`missing_required_input: ${key} not received for active plan revision=${activePlan.revision}`);
      }

      const refs = asRecord(activePlan.refs);
      const planUnits = asRecordArray(refs.executionUnits);
      const planUnitKeys = new Set(planUnits.map((unit) => executionUnitKeyFromSourceRef(unit.sourceRef)).filter((key): key is string => Boolean(key)));
      for (const unit of executionSnapshot.units) {
        if (!planUnitKeys.has(executionUnitKey(unit))) {
          findings.push(`plan_outdated: active execution unit missing from plan refs source=${unit.sourceRef.type} id=${unit.sourceRef.id}`);
        }
      }

      const approvalRuleRefs = asRecordArray(refs.ruleRefs).filter((ruleRef) => isApprovalRuleMode(ruleRef.mode));
      for (const ruleRef of approvalRuleRefs) {
        const ruleLabel = trimmedString(ruleRef.key) ?? trimmedString(ruleRef.id) ?? trimmedString(ruleRef.name) ?? "rule";
        for (const planUnit of planUnits) {
          if (!unitRequiresGovernedAction(planUnit)) continue;
          const key = executionUnitKeyFromSourceRef(planUnit.sourceRef) ?? "unknown-unit";
          findings.push(`approval_required: ${ruleLabel} requires owner approval for governed action unit=${key}`);
          addRecommendation({
            type: "request_approval",
            missionId: mission.id,
            sourceRef: asRecord(planUnit.sourceRef) as unknown as MissionExecutionSourceRef,
            reason: `Rule ${ruleLabel} requires owner approval for governed action unit ${key}`,
            safeToAutoApply: false,
          });
        }
      }

      for (const planUnit of planUnits) {
        const expectedStatus = normalizedPlanStatus(planUnit.status);
        if (!expectedStatus) continue;
        const key = executionUnitKeyFromSourceRef(planUnit.sourceRef);
        if (!key) continue;
        const runtimeUnit = executionSnapshot.units.find((unit) => executionUnitKey(unit) === key);
        if (!runtimeUnit || normalizedPlanStatus(runtimeUnit.status) === expectedStatus) continue;
        findings.push(`rule_mismatch: plan unit=${key} status=${expectedStatus} runtime_status=${runtimeUnit.status}`);
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
        ...(governanceEvidenceLines.length > 0
          ? [
            ...governanceEvidenceLines,
            "",
          ]
          : []),
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

  const ACTIVE_SUPERVISION_EXECUTION_STATUSES = new Set<MissionExecutionStatus>(["pending", "running", "failed", "cancelled", "timed_out"]);

  function isActiveSupervisionExecutionStatus(status: MissionExecutionStatus): boolean {
    return status === "pending" || status === "running" || isTerminalFailureStatus(status);
  }

  async function runActiveMissionOwnerSupervision(input: {
    companyId?: string;
    missionIds?: string[];
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
  } = {}): Promise<ActiveMissionOwnerSupervisionResult> {
    const filters = [eq(missions.status, "active")];
    if (input.companyId) filters.push(eq(missions.companyId, input.companyId));
    if (input.missionIds && input.missionIds.length > 0) filters.push(inArray(missions.id, input.missionIds));

    const missionRows = await db
      .select({ id: missions.id, companyId: missions.companyId, createdAt: missions.createdAt })
      .from(missions)
      .where(and(...filters))
      .orderBy(asc(missions.createdAt), asc(missions.id));

    const missionIds: string[] = [];
    const missionRowsByCompanyId = new Map<string, typeof missionRows>();
    for (const row of missionRows) {
      const rows = missionRowsByCompanyId.get(row.companyId) ?? [];
      rows.push(row);
      missionRowsByCompanyId.set(row.companyId, rows);
    }

    const now = input.now ?? new Date();
    const staleCutoff = new Date(now.getTime() - Math.max(1, input.staleAfterMinutes ?? 120) * 60 * 1000);

    for (const [companyId, rows] of missionRowsByCompanyId) {
      const rowMissionIds = rows.map((row) => row.id);
      const snapshots = await listMissionExecutionSourceSnapshots(db, {
        companyId,
        missionIds: rowMissionIds,
      });
      const staleFailedHeartbeatMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              inArray(issues.status, ["todo", "backlog"]),
              lte(issues.createdAt, staleCutoff),
              eq(heartbeatRuns.status, "failed"),
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
          : [],
      );

      for (const row of rows) {
        const snapshot = snapshots[row.id];
        const hasSupervisionUnit = snapshot?.units.some((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES.has(unit.status) && isActiveSupervisionExecutionStatus(unit.status));
        if (hasSupervisionUnit || staleFailedHeartbeatMissionIds.has(row.id)) missionIds.push(row.id);
      }
    }

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
        const existingMission = await getById(existingActiveWorkflowMission.id);
        await ensureMainExecutorOversightIssue(existingMission, input.title);
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

    if ((input.source ?? "manual") === "workflow") {
      await ensureMainExecutorOversightIssue(mission, input.title);
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

    const activeMissionPlan = await missionPlanArtifactService(db).getActiveMissionPlan({
      companyId: mission.companyId,
      missionId: id,
    });

    return {
      ...mission,
      agents: agentRows.map((r: { row: typeof missionAgents.$inferSelect; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined })),
      ownerAgentName: ownerRow?.name,
      sessionBindings,
      activeMissionPlan: summarizeMissionPlanForRuntime(activeMissionPlan),
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
    ensureMissionExecutionPlan,
    runMainExecutorSupervision,
    runActiveMissionOwnerSupervision,
  };
}

export type MissionService = ReturnType<typeof missionService>;
