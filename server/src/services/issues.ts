import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueAttachments,
  issueInboxArchives,
  issueLabels,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueWorkProducts,
  issues,
  labels,
  missions,
  projectWorkspaces,
  projects,
  pluginEntities,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { extractAgentMentionIds, extractProjectMentionIds } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "./mission-owner-plan-decisions.js";
import { logger } from "../middleware/logger.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

async function assertCanCompleteMissionOversightIssue(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.originKind !== "mission_main_executor_oversight" || !issue.missionId) return;

  const [mission] = await db
    .select({ id: missions.id, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
    .limit(1);
  if (!mission || TERMINAL_MISSION_STATUSES.has(mission.status)) return;

  const openWork = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, issue.companyId),
      eq(issues.missionId, issue.missionId),
      isNull(issues.hiddenAt),
      ne(issues.id, issue.id),
      sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
      sql`${issues.status} not in ('done', 'cancelled')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (openWork) {
    throw unprocessable(
      `Cannot complete mission oversight while mission work remains open (${openWork.identifier ?? openWork.id}: ${openWork.status}).`,
    );
  }

  const activeWorkflowRun = await db
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.companyId, issue.companyId),
      eq(workflowRuns.missionId, issue.missionId),
      sql`${workflowRuns.status} not in ('completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'canceled', 'aborted')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (activeWorkflowRun) {
    throw unprocessable(
      `Cannot complete mission oversight while workflow run ${activeWorkflowRun.id} is ${activeWorkflowRun.status}.`,
    );
  }

  const activePluginWorkflowRun = await db
    .select({
      id: pluginEntities.id,
      data: pluginEntities.data,
    })
    .from(pluginEntities)
    .where(and(
      eq(pluginEntities.entityType, "workflow-run"),
      eq(pluginEntities.scopeKind, "company"),
      eq(pluginEntities.scopeId, issue.companyId),
      sql`${pluginEntities.data} ->> 'missionId' = ${issue.missionId}`,
      sql`coalesce(${pluginEntities.data} ->> 'status', '') not in ('completed', 'succeeded', 'done', 'failed', 'error', 'cancelled', 'canceled', 'aborted', 'timed-out')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (activePluginWorkflowRun) {
    const status = activePluginWorkflowRun.data
      && typeof activePluginWorkflowRun.data === "object"
      && !Array.isArray(activePluginWorkflowRun.data)
      ? String((activePluginWorkflowRun.data as Record<string, unknown>).status ?? "unknown")
      : "unknown";
    throw unprocessable(
      `Cannot complete mission oversight while plugin workflow run ${activePluginWorkflowRun.id} is ${status}.`,
    );
  }

  const activeWorkflowStep = await db
    .select({
      runId: workflowRuns.id,
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowRuns.companyId, issue.companyId),
      eq(workflowRuns.missionId, issue.missionId),
      sql`${workflowStepRuns.status} not in ('completed', 'failed', 'skipped', 'cancelled', 'canceled')`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (activeWorkflowStep) {
    throw unprocessable(
      `Cannot complete mission oversight while workflow step ${activeWorkflowStep.stepId} is ${activeWorkflowStep.status}.`,
    );
  }
}

export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  parentId?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  missionId?: string;
  includeRoutineExecutions?: boolean;
  q?: string;
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type IssueWriteDb = Pick<Db, "select" | "insert" | "update" | "delete">;

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MISSION_OWNER_CHILD_ISSUE_BURST_LIMIT = 6;

const MISSION_OWNER_PLANNED_DOWNSTREAM_RE =
  /\b(synthesis|synthesize|validation|validator|validate|qa|quality\s+assurance|director\s+gate|gate|close\s+mission|final\s+review|final\s+report|write\s+(?:korean\s+)?(?:html\s+)?report)\b|종합|합성|검증|품질\s*검사|최종\s*검토|보고서\s*작성/iu;

const MISSION_OWNER_PLANNED_SOURCE_RE =
  /\b(scout|source|sources|dossier|roster|evidence|research|candidate|lead\s+map|discovery|collect|fact|facts|issues?-\d+|issues?)\b|자료|출처|근거|후보|쟁점|조사|수집/iu;

const MISSION_OWNER_PLANNED_DOWNSTREAM_PREFIX_RE =
  /^\s*\[(?:synthesis|validation|validator|qa|director\s+gate|gate)\]/iu;

const MISSION_OWNER_PLANNED_DOWNSTREAM_TITLE_RE =
  /\b(review\s+gate|independent\s+(?:evidence\s+)?review|evidence\s+matrix\s+validation|validation|validate|validator|qa|gate)\b|검증|품질\s*검사|최종\s*검토/iu;

const MISSION_OWNER_DOWNSTREAM_AGENT_NAME_RE =
  /\b(?:synthesis|validator|validation|qa)\b|종합|합성|검증/iu;

export type IssueGroupPhase = "plan" | "action" | "qa" | "oversight";

const ISSUE_GROUP_PREFIX_RE = /^\s*\[(plan|action|qa|oversight)\]/iu;

export function classifyIssueGroupPhase(input: {
  originKind?: string | null;
  title?: string | null;
}): IssueGroupPhase | null {
  const prefix = ISSUE_GROUP_PREFIX_RE.exec(input.title ?? "");
  if (prefix) return prefix[1]!.toLowerCase() as IssueGroupPhase;

  const originKind = (input.originKind ?? "").toLowerCase();
  if (originKind.includes("oversight") || originKind.includes("unblock")) return "oversight";
  if (originKind.includes("qa") || originKind.includes("validation") || originKind.includes("validator")) return "qa";
  if (originKind.includes("action") || originKind.includes("source") || originKind.includes("worker")) return "action";
  if (originKind.includes("plan")) return "plan";
  return null;
}

function isMissionLevelGroupedIssue(data: {
  missionId?: string | null;
  parentId?: string | null;
  originKind?: string | null;
  title?: string | null;
}) {
  if (!data.missionId || data.parentId) return false;
  const group = classifyIssueGroupPhase(data);
  return group === "action" || group === "qa" || group === "oversight";
}

function isServerWorkflowExecutionIssue(data: {
  originKind?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}) {
  return data.originKind === "workflow_execution" && !data.createdByAgentId && !data.createdByUserId;
}

function assertAgentDoesNotCreateLooseMissionStructureIssue(data: Omit<typeof issues.$inferInsert, "companyId">) {
  if (!data.createdByAgentId) return;
  if (!isMissionLevelGroupedIssue(data)) return;

  const group = classifyIssueGroupPhase(data);
  throw unprocessable(
    `Agent-created mission-level ${group?.toUpperCase() ?? "work"} issues must be materialized through the mission structure layer and server-native DAG, not created as loose issues. Post a structured Mission owner plan decision instead.`,
  );
}

function isMissionOwnerPlanOriginKind(originKind: string) {
  return originKind === "research_director_plan" ||
    originKind === "research-director-plan" ||
    originKind === "research_director_plan_child" ||
    originKind === "research-director-plan-child";
}

function isMissionPlannedDownstreamIssue(data: {
  missionId?: string | null;
  parentId?: string | null;
  originKind?: string | null;
  status?: string | null;
  title?: string | null;
  description?: string | null;
  createdByUserId?: string | null;
}) {
  if (!data.missionId) return false;
  const originKind = data.originKind ?? "manual";
  const isOwnerPlanIssue = isMissionOwnerPlanOriginKind(originKind);
  const isAgentPlannedChildIssue = !!data.parentId && !data.createdByUserId;
  if (!isOwnerPlanIssue && !isAgentPlannedChildIssue) return false;
  if (data.status === "done" || data.status === "cancelled") return false;

  const text = [data.title, data.description].filter((value): value is string => typeof value === "string").join("\n");
  if (!MISSION_OWNER_PLANNED_DOWNSTREAM_RE.test(text)) return false;

  const firstLine = data.title ?? "";
  if (MISSION_OWNER_PLANNED_DOWNSTREAM_PREFIX_RE.test(firstLine)) return true;
  if (MISSION_OWNER_PLANNED_DOWNSTREAM_TITLE_RE.test(firstLine)) return true;
  return !MISSION_OWNER_PLANNED_SOURCE_RE.test(firstLine);
}

async function isMissionDownstreamAssignee(
  db: Db,
  companyId: string,
  assigneeAgentId: string | null | undefined,
) {
  if (!assigneeAgentId) return false;
  const agent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return MISSION_OWNER_DOWNSTREAM_AGENT_NAME_RE.test(agent?.name ?? "");
}

async function hasCompletedSiblingUpstreamWorkProduct(
  db: Db,
  input: {
    companyId: string;
    missionId: string | null | undefined;
    parentId: string | null | undefined;
  },
) {
  if (!input.missionId || !input.parentId) return false;
  const existing = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.parentId, input.parentId),
      eq(issues.status, "done"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return !!existing;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

function lastExternalCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND (
          ${issueComments.authorUserId} IS NULL
          OR ${issueComments.authorUserId} <> ${userId}
        )
    )
  `;
}

function issueLastActivityAtExpr(companyId: string, userId: string) {
  const lastExternalCommentAt = lastExternalCommentAtExpr(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<Date>`
    COALESCE(
      ${lastExternalCommentAt},
      CASE
        WHEN ${issues.updatedAt} > COALESCE(${myLastTouchAt}, to_timestamp(0))
        THEN ${issues.updatedAt}
        ELSE to_timestamp(0)
      END
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  const issueLastActivityAt = issueLastActivityAtExpr(companyId, userId);
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issueLastActivityAt}
    )
  `;
}

/** Named entities commonly emitted in saved issue bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      issueId: issueLabels.issueId,
      label: labels,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.issueId);
    if (existing) existing.push(row.label);
    else map.set(row.issueId, [row.label]);
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      issueGroup: classifyIssueGroupPhase(row),
      groupSource: classifyIssueGroupPhase(row) ? "originKind_or_title_prefix" : null,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  const rows = await dbOrTx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.id, runIds),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );

  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProjectWorkspace(companyId: string, projectId: string | null | undefined, projectWorkspaceId: string) {
    const workspace = await db
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidExecutionWorkspace(companyId: string, projectId: string | null | undefined, executionWorkspaceId: string) {
    const workspace = await db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function getValidParentIssue(companyId: string, parentId: string) {
    const parent = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        missionId: issues.missionId,
        parentId: issues.parentId,
      })
      .from(issues)
      .where(eq(issues.id, parentId))
      .then((rows) => rows[0] ?? null);
    if (!parent) throw notFound("Parent issue not found");
    if (parent.companyId !== companyId) {
      throw unprocessable("Parent issue must belong to same company");
    }
    return parent;
  }

  async function assertMissionChildIssueCreationAllowed(
    companyId: string,
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  ) {
    if (!data.parentId || data.createdByUserId) return;
    if (isServerWorkflowExecutionIssue(data)) return;

    const parent = await getValidParentIssue(companyId, data.parentId);
    const missionId = data.missionId ?? parent.missionId;
    if (!missionId) return;

    if (parent.parentId) {
      throw unprocessable(
        "Mission nested child issue creation is not allowed: complete the assigned issue artifact instead of delegating sub-issues",
      );
    }

    const missionChildData = { ...data, missionId };
    const isDownstreamMissionChild =
      isMissionPlannedDownstreamIssue(missionChildData) ||
      await isMissionDownstreamAssignee(db, companyId, data.assigneeAgentId);
    if (isDownstreamMissionChild) {
      const hasUpstreamWorkProduct = await hasCompletedSiblingUpstreamWorkProduct(db, {
        companyId,
        missionId,
        parentId: data.parentId,
      });
      if (!hasUpstreamWorkProduct) {
        throw unprocessable(
          "Mission downstream issue creation is not allowed before its upstream artifact is complete; record the gate in the active plan instead",
        );
      }
    }

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.missionId, missionId),
          eq(issues.parentId, data.parentId),
          sql`${issues.status} not in ('done', 'cancelled')`,
        ),
      );
    const siblingCount = Number(countRow?.count ?? 0);
    if (siblingCount >= MISSION_OWNER_CHILD_ISSUE_BURST_LIMIT) {
      throw unprocessable(
        `Mission child issue burst limit exceeded: at most ${MISSION_OWNER_CHILD_ISSUE_BURST_LIMIT} active child issues can be created for one parent before upstream work is reviewed`,
      );
    }
  }

  async function inheritParentMissionId(
    companyId: string,
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  ) {
    if (!data.parentId) return data;
    const parent = await getValidParentIssue(companyId, data.parentId);
    if (parent.missionId && !data.missionId) {
      data.missionId = parent.missionId;
    }
    return data;
  }

  function normalizeMissionChildIssueStatusForExecution(
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  ) {
    if (
      data.missionId &&
      data.parentId &&
      data.assigneeAgentId &&
      !data.createdByUserId &&
      data.status === "backlog"
    ) {
      data.status = "todo";
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function adoptStaleExecutionRunWithoutCheckout(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedExecutionRunId: string;
    expectedStatuses?: string[];
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedExecutionRunId);
    if (!stale) return null;

    const now = new Date();
    const statusCondition = input.expectedStatuses
      ? inArray(issues.status, input.expectedStatuses)
      : eq(issues.status, "in_progress");
    return await db
      .update(issues)
      .set({
        assigneeAgentId: input.actorAgentId,
        assigneeUserId: null,
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        status: "in_progress",
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          statusCondition,
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          eq(issues.executionRunId, input.expectedExecutionRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);
  }

  async function repairMalformedSameRunCheckoutLock(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const now = new Date();
    return await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          eq(issues.executionRunId, input.actorRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);
  }

  async function assertValidCreateInput(
    companyId: string,
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  ) {
    if (data.assigneeAgentId && data.assigneeUserId) {
      throw unprocessable("Issue can only have one assignee");
    }
    if (data.assigneeAgentId) {
      await assertAssignableAgent(companyId, data.assigneeAgentId);
    }
    if (data.assigneeUserId) {
      await assertAssignableUser(companyId, data.assigneeUserId);
    }
    if (data.projectWorkspaceId) {
      await assertValidProjectWorkspace(companyId, data.projectId, data.projectWorkspaceId);
    }
    if (data.executionWorkspaceId) {
      await assertValidExecutionWorkspace(companyId, data.projectId, data.executionWorkspaceId);
    }
    if (data.parentId) {
      await getValidParentIssue(companyId, data.parentId);
      await assertMissionChildIssueCreationAllowed(companyId, data);
    }
    if (data.missionId) {
      const [mission] = await db
        .select({ id: missions.id, companyId: missions.companyId, status: missions.status })
        .from(missions)
        .where(eq(missions.id, data.missionId))
        .limit(1);
      if (!mission) throw notFound(`Mission not found: ${data.missionId}`);
      if (mission.companyId !== companyId) {
        throw unprocessable("Mission must belong to the same company");
      }
      if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
        throw unprocessable("Cannot create issues for a completed or cancelled mission");
      }
      if (
        !data.createdByUserId &&
        !isServerWorkflowExecutionIssue(data) &&
        (isMissionPlannedDownstreamIssue(data) ||
          await isMissionDownstreamAssignee(db, companyId, data.assigneeAgentId))
      ) {
        if (!isMissionLevelGroupedIssue(data)) {
          const hasUpstreamWorkProduct = await hasCompletedSiblingUpstreamWorkProduct(db, {
            companyId,
            missionId: data.missionId,
            parentId: data.parentId,
          });
          if (!hasUpstreamWorkProduct) {
            throw unprocessable(
              "Mission downstream issue creation is not allowed before its upstream artifact is complete; create [ACTION]/[QA]/[OVERSIGHT] mission-level sibling issues instead of plan-child/downstream issues",
            );
          }
        }
      }
    }
    if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
      throw unprocessable("in_progress issues require an assignee");
    }
  }

  async function createIssueRecord(
    dbOrTx: IssueWriteDb,
    companyId: string,
    data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    isolatedWorkspacesEnabled: boolean,
  ) {
    const { labelIds: inputLabelIds, ...issueData } = data;
    assertAgentDoesNotCreateLooseMissionStructureIssue(issueData);
    const defaultCompanyGoal = await getDefaultCompanyGoal(dbOrTx, companyId);
    const projectGoalId = await getProjectDefaultGoalId(dbOrTx, companyId, issueData.projectId);
    let executionWorkspaceSettings =
      (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
    if (executionWorkspaceSettings == null && issueData.projectId) {
      const project = await dbOrTx
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
        .from(projects)
        .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      executionWorkspaceSettings =
        defaultIssueExecutionWorkspaceSettingsForProject(
          gateProjectExecutionWorkspacePolicy(
            parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
            isolatedWorkspacesEnabled,
          ),
        ) as Record<string, unknown> | null;
    }
    let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
    if (!projectWorkspaceId && issueData.projectId) {
      const project = await dbOrTx
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
        .from(projects)
        .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
      projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
      if (!projectWorkspaceId) {
        projectWorkspaceId = await dbOrTx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.companyId, companyId)))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
          .then((rows) => rows[0]?.id ?? null);
      }
    }
    const [company] = await dbOrTx
      .update(companies)
      .set({ issueCounter: sql`${companies.issueCounter} + 1` })
      .where(eq(companies.id, companyId))
      .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

    const issueNumber = company.issueCounter;
    const identifier = `${company.issuePrefix}-${issueNumber}`;

    const values = {
      ...issueData,
      originKind: issueData.originKind ?? "manual",
      goalId: resolveIssueGoalId({
        projectId: issueData.projectId,
        goalId: issueData.goalId ?? projectGoalId,
        defaultGoalId: defaultCompanyGoal?.id ?? null,
      }),
      ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
      companyId,
      issueNumber,
      identifier,
    } as typeof issues.$inferInsert;
    if (values.status === "in_progress" && !values.startedAt) {
      values.startedAt = new Date();
    }
    if (values.status === "done") {
      values.completedAt = new Date();
    }
    if (values.status === "cancelled") {
      values.cancelledAt = new Date();
    }

    const [issue] = await dbOrTx.insert(issues).values(values).returning();
    if (inputLabelIds) {
      await syncIssueLabels(issue.id, companyId, inputLabelIds, dbOrTx);
    }
    const [enriched] = await withIssueLabels(dbOrTx, [issue]);
    return enriched;
  }

  return {
    list: async (companyId: string, filters?: IssueFilters) => {
      const conditions = [eq(issues.companyId, companyId)];
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.missionId) conditions.push(eq(issues.missionId, filters.missionId));
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (!filters?.includeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(issues.originKind, "routine_execution"));
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${descriptionContainsMatch} THEN 4
          WHEN ${commentContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const rows = await db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(hasSearch ? asc(searchOrder) : asc(priorityOrder), asc(priorityOrder), desc(issues.updatedAt));
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (!contextUserId || withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const statsRows = await db
        .select({
          issueId: issueComments.issueId,
          myLastCommentAt: sql<Date | null>`
            MAX(CASE WHEN ${issueComments.authorUserId} = ${contextUserId} THEN ${issueComments.createdAt} END)
          `,
          lastExternalCommentAt: sql<Date | null>`
            MAX(
              CASE
                WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${contextUserId}
                THEN ${issueComments.createdAt}
              END
            )
          `,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
          ),
        )
        .groupBy(issueComments.issueId);
      const readRows = await db
        .select({
          issueId: issueReadStates.issueId,
          myLastReadAt: issueReadStates.lastReadAt,
        })
        .from(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.userId, contextUserId),
            inArray(issueReadStates.issueId, issueIds),
          ),
        );
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => ({
        ...row,
        ...deriveIssueUserContext(row, contextUserId, {
          myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
          myLastReadAt: readByIssueId.get(row.id) ?? null,
          lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
        }),
      }));
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        unreadForUserCondition(companyId, userId),
        ne(issues.originKind, "routine_execution"),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    archiveInbox: async (companyId: string, issueId: string, userId: string, archivedAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    getByIdentifier: async (identifier: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, identifier.toUpperCase()))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    create: async (
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    ) => {
      const { labelIds: inputLabelIds, ...issueData } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      await inheritParentMissionId(companyId, issueData);
      normalizeMissionChildIssueStatusForExecution(issueData);
      await assertValidCreateInput(companyId, issueData);
      return db.transaction(async (tx: IssueWriteDb) =>
        await createIssueRecord(tx, companyId, issueData, isolatedWorkspacesEnabled)
      );
    },

    createFromSrb: async (
      dbOrTx: IssueWriteDb,
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    ) => {
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete data.executionWorkspaceId;
        delete data.executionWorkspacePreference;
        delete data.executionWorkspaceSettings;
      }
      await inheritParentMissionId(companyId, data);
      normalizeMissionChildIssueStatusForExecution(data);
      await assertValidCreateInput(companyId, data);
      return await createIssueRecord(dbOrTx, companyId, data, isolatedWorkspacesEnabled);
    },

    update: async (id: string, data: Partial<typeof issues.$inferInsert> & { labelIds?: string[] }) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const { labelIds: nextLabelIds, ...issueData } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }
      if (issueData.status === "done" && existing.status !== "done") {
        await assertCanCompleteMissionOversightIssue(db, existing);
      }

      if (existing.missionId && issueData.status && issueData.status !== "done" && issueData.status !== "cancelled") {
        const [mission] = await db
          .select({ id: missions.id, status: missions.status })
          .from(missions)
          .where(and(eq(missions.id, existing.missionId), eq(missions.companyId, existing.companyId)))
          .limit(1);
        if (mission && TERMINAL_MISSION_STATUSES.has(mission.status)) {
          throw unprocessable("Cannot reopen or execute issues for a completed or cancelled mission");
        }
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (patch.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId);
      }
      if (issueData.missionId !== undefined) {
        if (issueData.missionId !== null) {
          const [mission] = await db
            .select({ id: missions.id, companyId: missions.companyId, status: missions.status })
            .from(missions)
            .where(eq(missions.id, issueData.missionId))
            .limit(1);
          if (!mission) throw notFound(`Mission not found: ${issueData.missionId}`);
          if (mission.companyId !== existing.companyId) {
            throw unprocessable("Mission must belong to the same company");
          }
          if (TERMINAL_MISSION_STATUSES.has(mission.status) && issueData.status !== "done" && issueData.status !== "cancelled") {
            throw unprocessable("Cannot move issues into a completed or cancelled mission");
          }
        }
      }
      const nextProjectId = issueData.projectId !== undefined ? issueData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        issueData.projectWorkspaceId !== undefined ? issueData.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        issueData.executionWorkspaceId !== undefined ? issueData.executionWorkspaceId : existing.executionWorkspaceId;
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.companyId, nextProjectId, nextExecutionWorkspaceId);
      }

      applyStatusSideEffects(issueData.status, patch);
      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const updatedIssue = await db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
          ),
        ]);
        const resolvedNextGoalId =
          issueData.goalId !== undefined
            ? issueData.goalId
            : (nextProjectGoalId ?? currentProjectGoalId ?? existing.goalId);
        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          projectId: issueData.projectId,
          goalId: resolvedNextGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      });

      if (
        updatedIssue &&
        issueData.status &&
        issueData.status !== existing.status &&
        (issueData.status === "done" || issueData.status === "blocked" || issueData.status === "cancelled")
      ) {
        try {
          const { finalizeDelegatedWorkflowTargetIssue } = await import("./workflow-delegations.js");
          await finalizeDelegatedWorkflowTargetIssue(db, {
            targetIssueId: updatedIssue.id,
            targetStatus: issueData.status,
          });
        } catch (err) {
          logger.warn(
            { err, issueId: updatedIssue.id, status: issueData.status },
            "failed to finalize delegated workflow target issue",
          );
        }
      }

      if (updatedIssue && issueData.status && issueData.status !== existing.status) {
        try {
          const { workflowService } = await import("./workflow/engine.js");
          await workflowService.syncRunStatusForIssue(db, updatedIssue.id);
        } catch (err) {
          logger.warn(
            { err, issueId: updatedIssue.id, status: issueData.status },
            "failed to sync workflow state after issue status update",
          );
        }
      }

      return updatedIssue;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.companyId, agentId);

      const now = new Date();
      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, expectedStatuses),
            or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const { syncSrbSourceIssueStatus } = await import("./srb/source-status-sync.js");
        await syncSrbSourceIssueStatus({
          db,
          issueId: updated.id,
          status: updated.status,
        });
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.checkoutRunId == null &&
        current.executionRunId &&
        current.executionRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleExecutionRunWithoutCheckout({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedExecutionRunId: current.executionRunId,
          expectedStatuses,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return {
          ...current,
          adoptedFromRunId: null as string | null,
          repairedMalformedExecutionLock: false,
        };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        current.executionRunId === actorRunId
      ) {
        const repaired = await repairMalformedSameRunCheckoutLock({
          issueId: id,
          actorAgentId,
          actorRunId,
        });

        if (repaired) {
          return {
            ...repaired,
            adoptedFromRunId: null as string | null,
            repairedMalformedExecutionLock: true,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
            repairedMalformedExecutionLock: false,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        current.executionRunId &&
        current.executionRunId !== actorRunId
      ) {
        const adopted = await adoptStaleExecutionRunWithoutCheckout({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedExecutionRunId: current.executionRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.executionRunId,
            repairedMalformedExecutionLock: false,
          };
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        throw conflict("Only checkout run can release issue", {
          issueId: existing.id,
          assigneeAgentId: existing.assigneeAgentId,
          checkoutRunId: existing.checkoutRunId,
          actorRunId: actorRunId ?? null,
        });
      }

      const updated = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const { syncSrbSourceIssueStatus } = await import("./srb/source-status-sync.js");
      await syncSrbSourceIssueStatus({
        db,
        issueId: updated.id,
        status: updated.status,
      });
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        conditions.push(
          order === "asc"
            ? sql<boolean>`(
                ${issueComments.createdAt} > ${anchor.createdAt}
                OR (${issueComments.createdAt} = ${anchor.createdAt} AND ${issueComments.id} > ${anchor.id})
              )`
            : sql<boolean>`(
                ${issueComments.createdAt} < ${anchor.createdAt}
                OR (${issueComments.createdAt} = ${anchor.createdAt} AND ${issueComments.id} < ${anchor.id})
              )`,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: (commentId: string) =>
      instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? redactIssueComment(comment, censorUsernameInLogs) : null;
        })),

    addComment: async (issueId: string, body: string, actor: { agentId?: string; userId?: string }) => {
      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          missionId: issues.missionId,
          originKind: issues.originKind,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      if (issue.originKind === "mission_main_executor_plan" && issue.missionId) {
        const requestedBy = actor.agentId
          ? { actorType: "agent" as const, actorId: actor.agentId }
          : actor.userId
            ? { actorType: "user" as const, actorId: actor.userId }
            : undefined;
        try {
          await recordLatestAuthorizedMissionOwnerPlanDecision({
            db,
            companyId: issue.companyId,
            missionId: issue.missionId,
            requestedBy,
          });
        } catch (err) {
          logger.warn(
            { err, issueId: issue.id, companyId: issue.companyId, missionId: issue.missionId },
            "failed to record mission owner plan decision from issue comment",
          );
        }
      }

      return redactIssueComment(comment, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let match = re.exec(body);
      while (match !== null) {
        const normalized = normalizeAgentMentionToken(match[1]);
        if (normalized) tokens.add(normalized.toLowerCase());
        match = re.exec(body);
      }

      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (tokens.size === 0 && explicitAgentMentionIds.length === 0) return [];
      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.companyId, companyId));
      const resolved = new Set<string>(explicitAgentMentionIds);
      for (const agent of rows) {
        if (tokens.has(agent.name.toLowerCase())) {
          resolved.add(agent.id);
        }
      }
      return [...resolved];
    },

    findMentionedProjectIds: async (issueId: string) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
