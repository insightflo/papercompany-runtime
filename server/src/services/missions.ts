/**
 * Mission Service
 *
 * CRUD operations for missions and mission_agents.
 * OQ-4 schema: owner_agent_id is the mission main executor; mission_agents carries executor/reviewer/observer roles.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentRuntimeState,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionAgents,
  missionPlanArtifacts,
  missionSessions,
  missions,
  pluginEntities,
  projects,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { notFound, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { missionPlanArtifactService, summarizeMissionPlanForRuntime, type MissionPlanRuntimeSummary } from "./mission-plan-artifacts.js";
import { type MissionSupervisionHeartbeatRun } from "./missions/mission-supervision-context.js";
import {
  buildOwnerActionExplanations,
  type MissionOwnerActionExplanation,
} from "./missions/mission-owner-recovery-explanations.js";
import { normalizeWorkflowStepsForExecution } from "./workflow/dag-engine.js";
import { normalizeConditionalEdges } from "./workflow/control-flow/types.js";
import { stopMissionRuntimesForMission } from "./missions/mission-runtime-manager.js";
import { asStringArray, asTrimmedString, parseMissionDateFilter, parsePluginDate } from "./missions/utils.js";
import {
  buildWorkflowRunProgress,
  normalizeMissionWorkflowStepStatus,
  normalizeMissionWorkflowStepType,
  type MissionWorkflowStepIssue,
  type MissionWorkflowStepWorkProduct,
  type MissionWorkflowRunStep,
  type MissionWorkflowRunDetail,
} from "./missions/workflow-progress.js";
import type {
  MissionOwnerDecisionWakeupDispatchResult,
} from "./missions/supervision-types.js";
import {
  normalizePluginWorkflowStepStatus,
  toPluginWorkflowStepData,
  type PluginWorkflowStepData,
  type PluginWorkflowDefinitionData,
  type PluginWorkflowRunData,
  type PluginWorkflowStepRunData,
} from "./missions/plugin-workflow.js";
import { isTerminalMissionStatus } from "./missions/shared-types.js";
import { createOwnerActions } from "./missions/owner-actions.js";
import { createSupervision } from "./missions/supervision.js";
import type { PlanQaWakeupHandler } from "./mission-owner-plan-decisions.js";
// [목적] mission 생성 시점에 working.md를 미리 provisioning 하기 위해 import.
// [외부 연결] create()에서 호출 → 첫 PLAN 런이 working.md를 발견하지 못해 실패하던 gap을 닫는다.
import { ensureMissionWorkingNote } from "./missions/mission-working-note.js";

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

export {
  MISSION_OWNER_DECISION_OPTIONS,
  buildMissionOwnerDecisionFormat,
  extractMissionOwnerDecisionFromText,
} from "./missions/mission-owner-recovery-events.js";
export type { ExtractedMissionOwnerDecision, MissionOwnerDecisionOption } from "./missions/mission-owner-recovery-events.js";
export type { MissionOwnerActionExplanation, MissionOwnerActionExplanationStatus } from "./missions/mission-owner-recovery-explanations.js";

/**
 * MissionAgent row type.
 */
export type MissionAgentRow = typeof missionAgents.$inferSelect;

/**
 * [목적] mission에 연결된 project의 표시용 라이트 참조.
 * [출력] { id, name, color } — 리스트 뱃지/상세 칩 렌더링에 쓰인다.
 * [연결] mission.projectId -> projects 행에서 id/name/color만 투영.
 */
export type MissionProjectRef = {
  id: string;
  name: string;
  color: string | null;
};

/**
 * Full mission detail with agents.
 */
export type MissionDetail = MissionRow & {
  agents: Array<MissionAgentRow & { agentName?: string }>;
  ownerAgentName?: string;
  project: MissionProjectRef | null;
  sessionBindings: Array<{
    agentId: string;
    adapterType: string;
    status: string;
    lastActiveAt: Date | null;
    runCount: number;
  }>;
  activeMissionPlan: MissionPlanRuntimeSummary;
  ownerActionExplanations: MissionOwnerActionExplanation[];
};

/**
 * [목적] missions 리스트 1행 응답 타입. MissionRow에 풀어낸 project 참조를 더한다.
 * [연결] list()가 batch로 projectId->project를 해석해 채운다. UI 리스트 뱃지용.
 */
export type MissionListItem = MissionRow & {
  project: MissionProjectRef | null;
};

// workflow-run step/progress 타입 + 정규화/집계 로직은 ./missions/workflow-progress.js 로 분리.
// 아래는 public API 호환용 re-export.
export type {
  MissionWorkflowStepIssue,
  MissionWorkflowStepWorkProduct,
  MissionWorkflowRunProgress,
  MissionWorkflowRunStep,
  MissionWorkflowRunDetail,
} from "./missions/workflow-progress.js";
export type MissionIssueTree = Awaited<ReturnType<ReturnType<typeof issueService>["list"]>>;

// supervision 결과 타입은 ./missions/supervision-types.js 로 분리(public API re-export).
export type {
  MissionOwnerSupervisionRecommendationType,
  MissionOwnerSupervisionRecommendation,
  MissionOwnerDecisionWakeupDispatchStatus,
  MissionOwnerDecisionWakeupDispatchResult,
  MissionOwnerSupervisionAppliedAction,
  MissionOwnerSupervisionResult,
  ActiveMissionOwnerSupervisionResult,
} from "./missions/supervision-types.js";

async function buildMissionOwnerActionExplanations(db: Db, mission: MissionRow): Promise<MissionOwnerActionExplanation[]> {
  const ownerActionIssues = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, mission.companyId),
      eq(issues.missionId, mission.id),
      eq(issues.originKind, "mission_main_executor_unblock"),
      isNull(issues.hiddenAt),
    ));

  const commentsByIssueId = new Map<string, string[]>();
  for (const ownerActionIssue of ownerActionIssues) {
    const ownerActionCommentRows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, ownerActionIssue.id)))
      .orderBy(asc(issueComments.createdAt));
    commentsByIssueId.set(ownerActionIssue.id, ownerActionCommentRows.map((comment) => comment.body));
  }

  return buildOwnerActionExplanations({
    ownerActionIssues,
    commentsByIssueId,
    resolveSourceIssue: async (sourceIssueId) => db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(
        eq(issues.id, sourceIssueId),
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        isNull(issues.hiddenAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    resolveSourceComments: async (sourceIssueId) => db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, sourceIssueId)))
      .then((rows) => rows.map((comment) => comment.body)),
  });
}

/**
 * [목적] projectId -> 표시용 project 라이트 참조 단건 해석. 상세 헤더/단건 응답용.
 * [입력] db, projectId. [출력] { id, name, color } | null(없거나 삭제된 project).
 * [연결] getById가 호출. projects 테이블에서 id/name/color만 투영한다.
 */
async function resolveProjectRef(db: Db, projectId: string): Promise<MissionProjectRef | null> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, color: projects.color })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ? { id: row.id, name: row.name, color: row.color } : null;
}

/**
 * [목적] 여러 projectId를 한 번에 해석해 Map으로 반환. 리스트 batch enrich용(N+1 방지).
 * [입력] db, projectId 배열. [출력] Map<projectId, MissionProjectRef>.
 * [주의] 빈 배열 입력 시 쿼리하지 않고 빈 Map 반환(inArray 빈 값 회피).
 */
async function resolveProjectRefs(db: Db, projectIds: string[]): Promise<Map<string, MissionProjectRef>> {
  const map = new Map<string, MissionProjectRef>();
  if (projectIds.length === 0) return map;
  const rows = await db
    .select({ id: projects.id, name: projects.name, color: projects.color })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  for (const row of rows) map.set(row.id, { id: row.id, name: row.name, color: row.color });
  return map;
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
  // [연결] project 직접 지정. goalId와 중복 가능하며 project 연결의 권위 컬럼.
  projectId?: string;
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
  // [연결] project 재지정/해제(null). projectId를 권위로 둔다.
  projectId?: string | null;
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
  // [연결] project별 mission 필터(리스트/상세 project 표시와 함께 사용).
  projectId?: string;
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


// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type MissionOwnerActionCreatedHandler = (input: {
  mission: MissionRow;
  issue: typeof issues.$inferSelect;
  sourceIssue: typeof issues.$inferSelect;
  reason?: "mission_unblock_action_created" | "mission_unblock_action_stalled" | "tool_step_failure_recovery_created";
}) => Promise<unknown> | unknown;

export type MissionOwnerDecisionRetrySourceIssueAppliedHandler = (input: {
  mission: MissionRow;
  ownerActionIssue: typeof issues.$inferSelect;
  sourceIssue: typeof issues.$inferSelect;
  targetAgentId: string;
  idempotencyKey: string;
  wakeCommentId?: string;
}) => Promise<MissionOwnerDecisionWakeupDispatchResult | unknown> | MissionOwnerDecisionWakeupDispatchResult | unknown;

export type MissionStaleSourceIssueWakeupRequestedHandler = (input: {
  mission: MissionRow;
  sourceIssue: typeof issues.$inferSelect;
  targetAgentId: string;
  failedRun: MissionSupervisionHeartbeatRun;
  idempotencyKey: string;
  wakeCommentId?: string;
}) => Promise<unknown> | unknown;

export type MissionWorkProductReuseWakeRequestedHandler = (input: {
  mission: MissionRow;
  sourceIssue: typeof issues.$inferSelect;
  targetAgentId: string;
  artifactPath: string;
  stalledRecoveryIssueId: string;
  stalledRun: MissionSupervisionHeartbeatRun;
  idempotencyKey: string;
  wakeCommentId?: string;
}) => Promise<unknown> | unknown;

export type MissionOwnerPlanningIssueCreatedHandler = (input: {
  mission: MissionRow;
  issue: typeof issues.$inferSelect;
  targetAgentId: string;
  idempotencyKey: string;
}) => Promise<unknown> | unknown;

export interface MissionServiceDeps {
  onOwnerActionCreated?: MissionOwnerActionCreatedHandler;
  onOwnerDecisionRetrySourceIssueApplied?: MissionOwnerDecisionRetrySourceIssueAppliedHandler;
  onStaleSourceIssueWakeupRequested?: MissionStaleSourceIssueWakeupRequestedHandler;
  onWorkProductReuseWakeRequested?: MissionWorkProductReuseWakeRequestedHandler;
  onOwnerPlanningIssueCreated?: MissionOwnerPlanningIssueCreatedHandler;
  onPlanQaIssueCreated?: PlanQaWakeupHandler;
  /** Cancel a heartbeat run (kills the process + updates DB + releases issue lock). */
  cancelHeartbeatRun?: (runId: string) => Promise<unknown>;
}

export function missionService(db: Db, deps: MissionServiceDeps = {}) {
  const ownerActions = createOwnerActions({ db, deps });
  const supervision = createSupervision({ db, deps, ownerActions });

  /**
   * Create a new mission.
   */
  async function create(input: CreateMissionInput): Promise<MissionDetail> {
    if (input.status) validateStatus(input.status);
    const missionSource = input.source === "workflow" ? "workflow" : "manual";

    // Verify owner agent exists
    const [ownerRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.ownerAgentId))
      .limit(1);
    if (!ownerRow) throw notFound(`Agent not found: ${input.ownerAgentId}`);

    if (missionSource === "workflow" && (input.status ?? "planning") === "active") {
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
        if (existingMission.status === "active") {
          await ownerActions.ensureMainExecutorOversightIssue(existingMission, input.title);
          return getById(existingActiveWorkflowMission.id);
        }
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
        projectId: input.projectId ?? null,
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

    if (missionSource === "workflow") {
      await ownerActions.ensureMainExecutorOversightIssue(mission, input.title);
    }

    if (missionSource === "manual") {
      const planningIssue = await ownerActions.ensureMainExecutorPlanningIssue(mission);
      await missionPlanArtifactService(db).createInitialMissionPlan({
        companyId: mission.companyId,
        missionId: mission.id,
        refs: planningIssue?.id ? { planningIssueId: planningIssue.id } : {},
        assumptions: [
          "Manual mission: the mission owner must finish the source/synthesis/QA execution skeleton before delegated child issues are treated as runnable recovery targets.",
        ],
        requiredInputs: [
          { key: "mission-owner-execution-plan", status: "pending", source: "mission_main_executor_plan" },
        ],
        successCriteria: [
          { description: "The active plan contains the source, synthesis, and QA gates needed to decide execution order." },
          { description: "QA or validation work starts only after its upstream source or synthesis artifact exists." },
          { description: "Timeout/process_lost recovery records root-cause judgement before choosing same-issue wakeup or a recovery issue." },
        ],
        risks: [
          { description: "Child issues can multiply if blocked status is treated as sufficient reason to create unblock/recovery work.", category: "issue_explosion", severity: "high" },
        ],
        steps: [
          { id: "plan-skeleton", title: "Define the source, synthesis, and QA execution skeleton", status: "planned", intendedRole: "mission_owner" },
          { id: "source-artifacts", title: "Collect bounded source artifacts before downstream QA starts", status: "planned", intendedRole: "source_research" },
          { id: "synthesis-artifact", title: "Synthesize completed sources into the requested output artifact", status: "planned", intendedRole: "synthesis" },
          { id: "qa-after-artifact", title: "Run QA only after the upstream artifact is present", status: "planned", intendedRole: "qa" },
        ],
      });
      await ownerActions.ensureMainExecutorOversightIssue(mission, input.title);
      if (deps.onOwnerPlanningIssueCreated && planningIssue?.assigneeAgentId) {
        const idempotencyKey = `mission-owner-planning-wakeup:${mission.id}:${planningIssue.id}`;
        void Promise.resolve(deps.onOwnerPlanningIssueCreated({
          mission,
          issue: planningIssue,
          targetAgentId: planningIssue.assigneeAgentId,
          idempotencyKey,
        })).catch((err) => {
          logger.warn({ err, missionId: mission.id, issueId: planningIssue.id }, "failed to notify owner about mission planning issue");
        });
      }
    }

    // [목적] 첫 PLAN 런이 working.md를 발견하도록 mission 생성 시점에 미리 provisioning 한다.
    //   compileMissionRunContext가 working.md를 lazily 읽으나, PLAN 런이 그 시점에 파일이
    //   없으면 실패한다. create()에서 보장하면 모든 생성 경로(수동/위임/워크플로)가 커버된다.
    // [주의] INSERT 이후 단계이므로 scratch note fs 실패가 생성 자체를 중단/롤백시키면 안 된다.
    //   swallow + log 한다. compiler의 idempotent 호출(wx 플래그, EEXIST 무시)이 다음 런에 self-heal.
    // [수정시 영향] ensureMissionWorkingNote 경로(PAPERCLIP_HOME/mission-working-notes) 변경 시 함께 검토.
    try {
      await ensureMissionWorkingNote({ companyId: mission.companyId, missionId: mission.id });
    } catch (err) {
      logger.warn(
        { err, missionId: mission.id, companyId: mission.companyId },
        "failed to provision mission working note at create",
      );
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
    mission = await ownerActions.reconcileMissionStatusFromWorkflowRuns(mission);

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
    const ownerActionExplanations = await buildMissionOwnerActionExplanations(db, mission);

    // [목적] mission.projectId -> 표시용 project 참조 해석. 상세 헤더 칩 렌더링용.
    // [입력] mission.projectId(nullable). [출력] { id, name, color } | null.
    const project = mission.projectId ? await resolveProjectRef(db, mission.projectId) : null;

    return {
      ...mission,
      agents: agentRows.map((r: { row: typeof missionAgents.$inferSelect; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined })),
      ownerAgentName: ownerRow?.name,
      project,
      sessionBindings,
      activeMissionPlan: summarizeMissionPlanForRuntime(activeMissionPlan),
      ownerActionExplanations,
    };
  }

  /**
   * List missions with optional filters.
   */
  async function list(filter: ListMissionsFilter): Promise<MissionListItem[]> {
    const conditions: ReturnType<typeof eq>[] = [eq(missions.companyId, filter.companyId)];

    if (filter.status) {
      validateStatus(filter.status);
      conditions.push(eq(missions.status, filter.status));
    }
    if (filter.ownerAgentId) conditions.push(eq(missions.ownerAgentId, filter.ownerAgentId));
    if (filter.goalId) conditions.push(eq(missions.goalId, filter.goalId));
    if (filter.projectId) conditions.push(eq(missions.projectId, filter.projectId));
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

    const reconciledRows = await Promise.all(rows.map((mission) => ownerActions.reconcileMissionStatusFromWorkflowRuns(mission)));
    const filteredRows = filter.status ? reconciledRows.filter((mission) => mission.status === filter.status) : reconciledRows;
    // [목적] 리스트 행에 project 참조를 batch 해석해 붙인다(N+1 방지).
    // [주의] projectMap 미스(삭제된 project)면 null로 내려가 뱃지가 숨김 처리된다.
    const projectMap = await resolveProjectRefs(db, [
      ...new Set(filteredRows.map((mission) => mission.projectId).filter((value): value is string => value !== null)),
    ]);
    return filteredRows.map((mission) => ({
      ...mission,
      project: mission.projectId ? (projectMap.get(mission.projectId) ?? null) : null,
    }));
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

    const now = new Date();
    const updates: Partial<MissionRow> = { updatedAt: now };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description ?? null;
    if (input.status !== undefined) {
      updates.status = input.status;
      if (input.status === "active" && input.startedAt === undefined && !existing.startedAt) {
        updates.startedAt = now;
      }
      if (isTerminalMissionStatus(input.status) && input.completedAt === undefined) {
        updates.completedAt = now;
      }
      if (!isTerminalMissionStatus(input.status) && input.completedAt === undefined) {
        updates.completedAt = null;
      }
    }
    if (input.goalId !== undefined) updates.goalId = input.goalId;
    // [연결] project 재지정/해제. null 명시적 해제, undefined는 미변경.
    if (input.projectId !== undefined) updates.projectId = input.projectId;
    if (input.startedAt !== undefined) updates.startedAt = input.startedAt;
    if (input.completedAt !== undefined) updates.completedAt = input.completedAt;

    await db
      .update(missions)
      .set(updates)
      .where(eq(missions.id, id));

    if (isTerminalMissionStatus(input.status)) {
      const terminalPlanStatus = input.status === "completed" ? "completed" : "archived";

      if (input.status === "cancelled") {
        await db
          .update(issues)
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where(and(
            eq(issues.missionId, id),
            sql`${issues.status} not in ('done', 'cancelled')`,
          ));
      }

      // Cancel active heartbeat runs for this mission's issues.
      // Use the heartbeat service cancel (kills the process + releases issue lock)
      // when available, falling back to a bulk DB update for callers that don't
      // inject the heartbeat dependency.
      const activeRunIds = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, existing.companyId),
          inArray(
            heartbeatRuns.issueId,
            db
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.missionId, id)),
          ),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ));

      if (activeRunIds.length && deps.cancelHeartbeatRun) {
        await Promise.all(
          activeRunIds.map((row) =>
            deps.cancelHeartbeatRun!(row.id).catch(() => {
              // Best-effort: cancelRunInternal already sets status, but if it
              // throws we fall through to the bulk update below.
            }),
          ),
        );
      }

      // Bulk-update any runs that are still queued/running (covers runs the
      // per-run cancel missed or callers without the heartbeat dependency).
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: `Cancelled because mission was ${input.status}`,
          errorCode: "cancelled",
          updatedAt: now,
        })
        .where(and(
          eq(heartbeatRuns.companyId, existing.companyId),
          inArray(
            heartbeatRuns.issueId,
            db
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.missionId, id)),
          ),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ));

      await stopMissionRuntimesForMission(db, {
        companyId: existing.companyId,
        missionId: id,
        reason: `mission.${input.status}`,
      });

      await db
        .update(missionPlanArtifacts)
        .set({ status: terminalPlanStatus, updatedAt: now })
        .where(and(
          eq(missionPlanArtifacts.companyId, existing.companyId),
          eq(missionPlanArtifacts.missionId, id),
          eq(missionPlanArtifacts.status, "active"),
        ));

      await db
        .update(missionSessions)
        .set({ status: "closed", lastActiveAt: now })
        .where(and(
          eq(missionSessions.companyId, existing.companyId),
          eq(missionSessions.missionId, id),
          eq(missionSessions.status, "active"),
        ));

      const missionAgentRows = await db
        .select({ agentId: missionAgents.agentId })
        .from(missionAgents)
        .where(eq(missionAgents.missionId, id));
      const issueAssigneeRows = await db
        .select({ agentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.missionId, id), sql`${issues.assigneeAgentId} is not null`));
      const affectedAgentIds = Array.from(new Set([
        existing.ownerAgentId,
        ...missionAgentRows.map((row) => row.agentId),
        ...issueAssigneeRows.map((row) => row.agentId).filter((agentId): agentId is string => Boolean(agentId)),
      ]));

      if (affectedAgentIds.length > 0) {
        await db
          .update(agents)
          .set({ status: "idle", updatedAt: now })
          .where(and(
            inArray(agents.id, affectedAgentIds),
            inArray(agents.status, ["running", "error"]),
          ));

        await db
          .update(agentRuntimeState)
          .set({ lastError: null, sessionId: null, updatedAt: now })
          .where(inArray(agentRuntimeState.agentId, affectedAgentIds));
      }

      if (input.status === "completed") {
        await ownerActions.completeOpenMissionOversightIfSettled(
          { ...existing, status: "completed", completedAt: updates.completedAt ?? existing.completedAt ?? now },
          updates.completedAt ?? existing.completedAt ?? now,
        );
      }

      try {
        const { missionDelegationService } = await import("./mission-delegations.js");
        await missionDelegationService(db).finalizeTargetMission({
          targetMissionId: id,
          targetStatus: input.status,
        });
      } catch (err) {
        logger.warn({ err, missionId: id, status: input.status }, "failed to finalize delegated target mission");
      }
    }

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
    await ownerActions.ensureWorkflowIssuesLinkedToMission(mission);

    const allCompanyIssues = await issuesSvc.list(mission.companyId);
    const includedIssueIds = new Set(
      allCompanyIssues.filter((issue) => issue.missionId === missionId).map((issue) => issue.id),
    );

    let addedDescendant = true;
    while (addedDescendant) {
      addedDescendant = false;
      for (const issue of allCompanyIssues) {
        if (includedIssueIds.has(issue.id)) continue;
        if (issue.parentId && includedIssueIds.has(issue.parentId)) {
          includedIssueIds.add(issue.id);
          addedDescendant = true;
        }
      }
    }

    return allCompanyIssues.filter((issue) => includedIssueIds.has(issue.id));
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

    const stepWorkProducts = stepIssueIds.length
      ? await db
          .select({
            id: issueWorkProducts.id,
            issueId: issueWorkProducts.issueId,
            title: issueWorkProducts.title,
            type: issueWorkProducts.type,
            url: issueWorkProducts.url,
            status: issueWorkProducts.status,
            summary: issueWorkProducts.summary,
            isPrimary: issueWorkProducts.isPrimary,
            metadata: issueWorkProducts.metadata,
            createdAt: issueWorkProducts.createdAt,
          })
          .from(issueWorkProducts)
          .where(inArray(issueWorkProducts.issueId, stepIssueIds))
          .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.createdAt))
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

    const stepWorkProductsMap = new Map<string, MissionWorkflowStepWorkProduct[]>();
    for (const product of stepWorkProducts) {
      const current = stepWorkProductsMap.get(product.issueId) ?? [];
      current.push({
        id: product.id,
        title: product.title,
        type: product.type,
        url: product.url,
        status: product.status,
        summary: product.summary,
        isPrimary: product.isPrimary,
        metadata: product.metadata ?? null,
        createdAt: product.createdAt,
      });
      stepWorkProductsMap.set(product.issueId, current);
    }

    const companyAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, mission.companyId));
    const agentIdByName = new Map(companyAgents.map((agent) => [agent.name, agent.id]));

    const nativeDetails = runs.map(({ run, workflowName, workflowSteps }) => {
      const definitionSteps = normalizeWorkflowStepsForExecution(workflowSteps);
      const definitionStepOrder = new Map(definitionSteps.map((step, index) => [step.id, index]));
      const rawStepRuns = [...(stepRunsMap.get(run.id) ?? [])].sort((left, right) => {
        const leftIndex = definitionStepOrder.get(left.stepId) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = definitionStepOrder.get(right.stepId) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || left.stepId.localeCompare(right.stepId);
      });
      const stepRunByStepId = new Map(rawStepRuns.map((stepRun) => [stepRun.stepId, stepRun]));

      const steps: MissionWorkflowRunStep[] = definitionSteps.map((step) => {
        const stepRun = stepRunByStepId.get(step.id);
        const persistedStep = step as typeof step & { agent?: unknown; agentName?: unknown; assigneeAgentName?: unknown; type?: unknown };
        const agentName =
          asTrimmedString(persistedStep.agentName)
          ?? asTrimmedString(persistedStep.agent)
          ?? asTrimmedString(persistedStep.assigneeAgentName);
        const agentId = asTrimmedString(step.agentId) ?? (agentName ? agentIdByName.get(agentName) : undefined) ?? "";
        return {
          stepId: step.id,
          name: step.name,
          type: normalizeMissionWorkflowStepType(persistedStep.type),
          agentId,
          dependencies: [...step.dependencies],
          conditionalDependencies: step.conditionalDependencies ?? [],
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
          workProducts: stepRun?.issueId ? stepWorkProductsMap.get(stepRun.issueId) ?? [] : [],
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
          type: "agent",
          agentId: "",
          dependencies: [],
          conditionalDependencies: [],
          description: null,
          toolNames: [],
          knowledgeBaseIds: [],
          status: normalizeMissionWorkflowStepStatus(stepRun.status),
          issueId: stepRun.issueId,
          issue: stepRun.issueId ? stepIssueMap.get(stepRun.issueId) ?? null : null,
          workProducts: stepRun.issueId ? stepWorkProductsMap.get(stepRun.issueId) ?? [] : [],
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
          type: normalizeMissionWorkflowStepType(step.type),
          agentId,
          dependencies: asStringArray(step.dependencies).length ? asStringArray(step.dependencies) : asStringArray(step.dependsOn),
          conditionalDependencies: normalizeConditionalEdges(step.conditionalDependencies) ?? [],
          description: asTrimmedString(step.description),
          toolNames: asStringArray(step.toolNames),
          knowledgeBaseIds: asStringArray(step.knowledgeBaseIds),
          status: stepRun ? normalizePluginWorkflowStepStatus(stepRun.status) : "pending",
          issueId: stepRun?.issueId ?? null,
          issue: stepRun?.issueId ? pluginIssueMap.get(stepRun.issueId) ?? null : null,
          workProducts: [],
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
          type: "agent",
          agentId: "",
          dependencies: [],
          conditionalDependencies: [],
          description: null,
          toolNames: [],
          knowledgeBaseIds: [],
          status: normalizePluginWorkflowStepStatus(stepRun.status),
          issueId: stepRun.issueId,
          issue: stepRun.issueId ? pluginIssueMap.get(stepRun.issueId) ?? null : null,
          workProducts: [],
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
    ensureMainExecutorUnblockIssue: ownerActions.ensureMainExecutorUnblockIssue,
    ensureMainExecutorOversightIssue: ownerActions.ensureMainExecutorOversightIssue,
    ensureMissionExecutionPlan: ownerActions.ensureMissionExecutionPlan,
    runMainExecutorSupervision: supervision.runMainExecutorSupervision,
    runActiveMissionOwnerSupervision: supervision.runActiveMissionOwnerSupervision,
  };
}

export type MissionService = ReturnType<typeof missionService>;
