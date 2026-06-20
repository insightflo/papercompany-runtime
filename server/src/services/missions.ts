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
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { HttpError, notFound, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { mergeMissionPlanRefs, missionPlanArtifactService, summarizeMissionPlanForRuntime, type MissionPlanRuntimeSummary } from "./mission-plan-artifacts.js";
import {
  isTerminalFailureStatus,
  listMissionExecutionSourceSnapshots,
  type MissionExecutionStatus,
  type MissionExecutionSourceRef,
} from "./missions/mission-execution-sources.js";
import { buildMissionRuleContext } from "./missions/mission-rule-context.js";
import { buildMissionSupervisionContext, type MissionSupervisionHeartbeatRun } from "./missions/mission-supervision-context.js";
import {
  formatGovernanceThreadEvidenceLines,
  governanceThreadReasonSuffix,
} from "./missions/mission-owner-recovery-governance-format.js";
import {
  buildOwnerActionExplanations,
  type MissionOwnerActionExplanation,
} from "./missions/mission-owner-recovery-explanations.js";
import { normalizeWorkflowStepsForExecution, retryIssueLessToolWorkflowStep, syncWorkflowRunState, type WorkflowStep } from "./workflow/dag-engine.js";
import { stopMissionRuntimesForMission } from "./missions/mission-runtime-manager.js";
import { asStringArray, asTrimmedString, isRecord, parseMissionDateFilter, parsePluginDate } from "./missions/utils.js";
import {
  buildWorkflowRunProgress,
  normalizeMissionWorkflowStepStatus,
  normalizeMissionWorkflowStepType,
  type MissionWorkflowStepIssue,
  type MissionWorkflowStepWorkProduct,
  type MissionWorkflowRunStep,
  type MissionWorkflowRunDetail,
} from "./missions/workflow-progress.js";
import {
  isIssueLessToolWorkflowStep,
} from "./missions/tool-step-failure.js";
import type {
  MissionOwnerSupervisionRecommendation,
  MissionOwnerDecisionWakeupDispatchStatus,
  MissionOwnerDecisionWakeupDispatchResult,
  MissionOwnerSupervisionAppliedAction,
  MissionOwnerSupervisionResult,
  ActiveMissionOwnerSupervisionResult,
} from "./missions/supervision-types.js";
import {
  normalizePluginWorkflowStepStatus,
  toPluginWorkflowStepData,
  type PluginWorkflowStepData,
  type PluginWorkflowDefinitionData,
  type PluginWorkflowRunData,
  type PluginWorkflowStepRunData,
} from "./missions/plugin-workflow.js";
import type { IssueCreateInput, IssueRow } from "./missions/shared-types.js";
import { isTerminalMissionStatus } from "./missions/shared-types.js";
import {
  activePlanRecoveryGateReason,
  asRecord,
  asRecordArray,
  buildNativeToolStepRetryAppliedMarker,
  executionUnitKey,
  executionUnitKeyFromSourceRef,
  findCanonicalToolStepRecoveryIssue,
  hasArtifactMissingSignal,
  hasDiagnosisSignal,
  hasNativeToolStepRetryAppliedMarker,
  hasRecoverableArtifactComment,
  isApprovalRuleMode,
  normalizedPlanStatus,
  parseToolStepRecoveryMarker,
  trimmedString,
  unitRequiresGovernedAction,
} from "./missions/supervision-helpers.js";
import { createOwnerActions } from "./missions/owner-actions.js";
import {
  buildMissionOwnerDecisionWakeupIdempotencyKey,
  hasMissionOwnerDecisionAppliedMarker,
  hasMissionOwnerDecisionWakeupDispatchedMarker,
  hasStaleSourceIssueWakeupDispatchedMarker,
} from "./missions/mission-owner-recovery-events.js";
import {
  buildRetrySourceIssueComment,
  buildRetrySourceIssueWakeupDispatchedComment,
  buildRetrySourceIssueWakeupHandledByWorkflowComment,
  buildStaleSourceIssueWakeupDispatchedComment,
  buildValidatorRetryEvidenceComment,
  isTerminalIssueStatus,
  extractLatestMissionOwnerDecision,
  summarizeOwnerDecisionNotApplied,
} from "./missions/mission-owner-recovery-comments.js";
import { buildMissionExecutionDigest } from "./missions/mission-execution-digest.js";
import { findLatestAuthorizedMissionOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision } from "./mission-owner-plan-decisions.js";
import { logActivity } from "./activity-log.js";

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
  ownerActionExplanations: MissionOwnerActionExplanation[];
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

function normalizeMissionOwnerDecisionWakeupDispatchResult(value: unknown): MissionOwnerDecisionWakeupDispatchStatus {
  if (!isRecord(value)) return "dispatched";
  switch (value.status) {
    case "not_requested":
    case "dispatched":
    case "workflow_already_dispatched":
    case "skipped_no_assignee":
    case "failed":
      return value.status;
    default:
      return "dispatched";
  }
}

function buildRetrySourceIssueWakeupResultComment(input: {
  status: MissionOwnerDecisionWakeupDispatchStatus;
  missionId: string;
  ownerActionIssueId: string;
  ownerActionLabel: string;
  sourceIssueId: string;
  sourceLabel: string;
  targetAgentId: string;
  idempotencyKey: string;
}) {
  const common = {
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    ownerActionLabel: input.ownerActionLabel,
    sourceIssueId: input.sourceIssueId,
    sourceLabel: input.sourceLabel,
    targetAgentId: input.targetAgentId,
    idempotencyKey: input.idempotencyKey,
  };
  return input.status === "workflow_already_dispatched"
    ? buildRetrySourceIssueWakeupHandledByWorkflowComment(common)
    : buildRetrySourceIssueWakeupDispatchedComment(common);
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
  onOwnerPlanningIssueCreated?: MissionOwnerPlanningIssueCreatedHandler;
  /** Cancel a heartbeat run (kills the process + updates DB + releases issue lock). */
  cancelHeartbeatRun?: (runId: string) => Promise<unknown>;
}

export function missionService(db: Db, deps: MissionServiceDeps = {}) {
  const ownerActions = createOwnerActions({ db, deps });

  async function runMainExecutorSupervision(input: {
    missionId: string;
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
    applyOwnerDecisionActions?: boolean;
    dispatchOwnerDecisionWakeups?: boolean;
    dispatchStalledOwnerActionWakeups?: boolean;
    dispatchStaleSourceIssueWakeups?: boolean;
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

    let oversightIssue = await ownerActions.findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (!oversightIssue) {
      await ownerActions.ensureMissionExecutionPlan({ companyId: mission.companyId, missionId: mission.id });
      oversightIssue = await ownerActions.findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    } else if (!isTerminalMissionStatus(mission.status) && isTerminalIssueStatus(oversightIssue.status)) {
      oversightIssue = await ownerActions.ensureMainExecutorOversightIssue(
        mission,
        oversightIssue.title.replace(/^\[OVERSIGHT\]\s*/, "") || mission.title,
      );
    }
    if (!oversightIssue) {
      return { missionId: mission.id, oversightIssueId: null, findings: [], recommendations: [], appliedActions: [], ownerActionExplanations: [], commented: false };
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
    const appliedActions: MissionOwnerSupervisionAppliedAction[] = [];
    const missionHasActiveHeartbeat = [...heartbeatRunsByIssueId.values()]
      .some((runs) => runs.some((run) => run.status === "queued" || run.status === "running"));
    const activePlanRefs = asRecord(activePlan?.refs);
    const activeOwnerPlanDecision = asRecord(activePlanRefs.ownerPlanDecision);
    const activePaqoWorkflow = asRecord(activePlanRefs.paqoWorkflow);
    const latestPlanDecision = await findLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: mission.companyId,
      missionId: mission.id,
    });
    const hasRecordedPlanDecision = Boolean(trimmedString(activeOwnerPlanDecision.decisionHash));
    const hasPaqoWorkflowRun = Boolean(trimmedString(activePaqoWorkflow.workflowRunId));
    if (latestPlanDecision.ok && (!hasRecordedPlanDecision || !hasPaqoWorkflowRun)) {
      findings.push(`plan_decision_not_materialized: planning_issue=${latestPlanDecision.planningIssueId} comment=${latestPlanDecision.commentId}`);
      addRecommendation({
        type: "materialize_plan_decision",
        missionId: mission.id,
        issueId: latestPlanDecision.planningIssueId,
        reason: "A structured Mission owner plan decision exists, but the active mission plan has no recorded PAQO workflow/run",
        safeToAutoApply: true,
      });
    }

    for (const issue of missionIssues) {
      if (issue.id === oversightIssue.id) continue;
      const ageMs = now.getTime() - issue.createdAt.getTime();
      const label = issue.identifier ?? issue.id;
      const runCount = heartbeatCountByIssueId.get(issue.id) ?? 0;
      const runsForIssue = heartbeatRunsByIssueId.get(issue.id) ?? [];
      const comments = commentsByIssueId.get(issue.id) ?? [];
      const stepRowsForIssue = stepRowsByIssueId.get(issue.id) ?? [];
      const hasActiveHeartbeat = runsForIssue.some((run) => run.status === "queued" || run.status === "running");
      const failedRunsForIssue = runsForIssue.filter((run) => run.status === "failed" || run.status === "timed_out" || run.error || run.errorCode || (run.exitCode != null && run.exitCode !== 0));
      const isStaleQueueStatus = issue.status === "todo" || issue.status === "backlog";
      const isRecoverableQueueSource = isStaleQueueStatus && issue.originKind !== "mission_main_executor_unblock";
      const isStaleInProgressSource = issue.status === "in_progress" && issue.originKind !== "mission_main_executor_unblock";
      const activePlanGateReason = activePlanRecoveryGateReason(activePlan, issue, stepRowsForIssue);

      if (activePlanGateReason) {
        findings.push(`plan_gate_not_ready: ${label} ${activePlanGateReason} — ${issue.title}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Execution timing is not satisfied for ${label}: ${activePlanGateReason}`,
          safeToAutoApply: false,
        });
        continue;
      }

      if (isStaleInProgressSource && ageMs >= staleAfterMs && !missionHasActiveHeartbeat) {
        const latestFailedRun = failedRunsForIssue
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (latestFailedRun && !hasActiveHeartbeat) {
          const idempotencyKey = `mission-stale-source-wakeup:${mission.id}:${issue.id}:${latestFailedRun.id}`;
          const markerInput = {
            missionId: mission.id,
            sourceIssueId: issue.id,
            failedRunId: latestFailedRun.id,
            idempotencyKey,
          };
          let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchStaleSourceIssueWakeups ? "skipped_no_assignee" : "not_requested";
          let wakeCommentId: string | undefined;
          const alreadyDispatched = hasStaleSourceIssueWakeupDispatchedMarker(comments, markerInput);
          const hasSourceDiagnosis = hasDiagnosisSignal(...comments);
          if (input.dispatchStaleSourceIssueWakeups && !alreadyDispatched && !hasSourceDiagnosis) {
            findings.push(`stale_source_wakeup_requires_diagnosis: ${label} terminal heartbeat run=${latestFailedRun.id} status=${latestFailedRun.status}${latestFailedRun.errorCode ? ` errorCode=${latestFailedRun.errorCode}` : ""}; diagnose root cause before choosing same-issue wakeup or recovery issue`);
            wakeupDispatchStatus = "not_requested";
          } else if (input.dispatchStaleSourceIssueWakeups && !alreadyDispatched) {
            if (!issue.assigneeAgentId) {
              findings.push(`stale_source_wakeup_skipped: ${label} in_progress source has terminal heartbeat run=${latestFailedRun.id} but no assignee; wakeup dispatch skipped`);
              wakeupDispatchStatus = "skipped_no_assignee";
            } else if (deps.onStaleSourceIssueWakeupRequested) {
              try {
                const wakeComment = await issueService(db).addComment(
                  issue.id,
                  buildStaleSourceIssueWakeupDispatchedComment({
                    missionId: mission.id,
                    sourceIssueId: issue.id,
                    sourceLabel: label,
                    failedRunId: latestFailedRun.id,
                    failedRunStatus: latestFailedRun.status,
                    targetAgentId: issue.assigneeAgentId,
                    idempotencyKey,
                  }),
                  { agentId: mission.ownerAgentId },
                );
                wakeCommentId = wakeComment.id;
                await deps.onStaleSourceIssueWakeupRequested({
                  mission,
                  sourceIssue: issue,
                  targetAgentId: issue.assigneeAgentId,
                  failedRun: latestFailedRun,
                  idempotencyKey,
                  wakeCommentId,
                });
                wakeupDispatchStatus = "dispatched";
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                findings.push(`stale_source_wakeup_failed: ${label} in_progress source wakeup callback failed — ${message}`);
                wakeupDispatchStatus = "failed";
              }
            } else {
              findings.push(`stale_source_wakeup_skipped: ${label} dispatchStaleSourceIssueWakeups enabled but no wakeup callback configured`);
              wakeupDispatchStatus = "failed";
            }
            appliedActions.push({
              type: "stale_source_issue_wakeup",
              missionId: mission.id,
              sourceIssueId: issue.id,
              failedRunId: latestFailedRun.id,
              resultStatus: issue.status,
              wakeupDispatchStatus,
              idempotencyKey,
            });
          }
          findings.push(`stale_in_progress_after_failed_run: ${label} in_progress has terminal heartbeat run=${latestFailedRun.id} status=${latestFailedRun.status}${latestFailedRun.errorCode ? ` errorCode=${latestFailedRun.errorCode}` : ""}${latestFailedRun.exitCode != null ? ` exitCode=${latestFailedRun.exitCode}` : ""}; no mission issue has queued/running execution — ${issue.title}; ${alreadyDispatched || wakeupDispatchStatus === "dispatched" ? "recovery_dispatched" : "diagnosed_only"}`);
          addRecommendation({
            type: "retry_unit_if_safe",
            missionId: mission.id,
            issueId: issue.id,
            reason: hasSourceDiagnosis
              ? `Source issue ${label} is still in_progress after diagnosed terminal heartbeat ${latestFailedRun.status}; choose same-issue wakeup only when the diagnosis says retry is safe`
              : `Source issue ${label} is still in_progress after terminal heartbeat ${latestFailedRun.status}; diagnose root cause before choosing same-issue wakeup or a recovery issue`,
            safeToAutoApply: false,
          });
        }
      }

      if (input.dispatchStalledOwnerActionWakeups && issue.originKind === "mission_main_executor_unblock" && isStaleQueueStatus && ageMs >= staleAfterMs && !missionHasActiveHeartbeat) {
        const sourceIssue = issue.originId ? missionIssueById.get(issue.originId) : null;
        const sourceLabel = sourceIssue ? (sourceIssue.identifier ?? sourceIssue.id) : (issue.originId ?? "unknown-source");
        const latestFailedRun = failedRunsForIssue
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (runsForIssue.length === 0) {
          findings.push(`owner_action_stalled_no_execution: ${label} ${issue.status} is an owner unblock action for ${sourceLabel} but has no heartbeat run and no mission issue has queued/running execution — ${issue.title}`);
        } else if (latestFailedRun && !hasActiveHeartbeat) {
          findings.push(`owner_action_stalled_after_failed_run: ${label} ${issue.status} is an owner unblock action for ${sourceLabel} after failed heartbeat run=${latestFailedRun.id} status=${latestFailedRun.status}${latestFailedRun.errorCode ? ` errorCode=${latestFailedRun.errorCode}` : ""}${latestFailedRun.exitCode != null ? ` exitCode=${latestFailedRun.exitCode}` : ""}; no mission issue has queued/running execution — ${issue.title}`);
        }
        if ((runsForIssue.length === 0 || latestFailedRun) && !hasActiveHeartbeat) {
          addRecommendation({
            type: "request_approval",
            missionId: mission.id,
            issueId: issue.id,
            reason: `Owner unblock action ${label} is stale while source ${sourceLabel} remains unresolved; re-wake the existing owner-action issue instead of creating a duplicate`,
            safeToAutoApply: false,
          });
          addRecommendation({
            type: "request_replan",
            missionId: mission.id,
            issueId: sourceIssue?.id ?? issue.originId ?? issue.id,
            reason: `Mission recovery is blocked because owner-action issue ${label} is not live; owner should recover, replan, or escalate if re-wake fails`,
            safeToAutoApply: false,
          });
          if (sourceIssue && deps.onOwnerActionCreated && input.dispatchStalledOwnerActionWakeups) {
            void Promise.resolve(deps.onOwnerActionCreated({
              mission,
              issue,
              sourceIssue,
              reason: "mission_unblock_action_stalled",
            })).catch((err) => {
              logger.warn({ err, missionId: mission.id, issueId: issue.id }, "failed to notify owner about stalled mission unblock action");
            });
          }
        }
      }

      if (isRecoverableQueueSource && ageMs >= staleAfterMs && !missionHasActiveHeartbeat && failedRunsForIssue.length === 0) {
        findings.push(`stale_todo_no_active_execution: ${label} ${issue.status} while no mission issue has queued/running execution — ${issue.title}`);
        addRecommendation({
          type: "retry_unit_if_safe",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Queued issue ${label} remains ${issue.status} while no mission issue has active execution; owner should diagnose before retry/re-dispatch`,
          safeToAutoApply: false,
        });
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Mission has stale queued work but no active execution; owner should recover, replan, or escalate`,
          safeToAutoApply: false,
        });
        if (issue.originKind !== "mission_main_executor_unblock" && !issue.hiddenAt && !isTerminalIssueStatus(issue.status)) {
          await ownerActions.ensureMainExecutorUnblockIssue(mission, issue, {
            renewAfterNoActionWaiting: true,
            governanceEvidence: [
              `stale_todo_no_active_execution: ${label} is ${issue.status}; no queued/running heartbeat run is active for any mission issue.`,
              "Preferred recovery boundary: choose retry_source_issue when this source issue is still non-terminal and assigned to the original executor; todo status alone does not prove the work is running.",
            ],
          });
        }
      }
      if (isRecoverableQueueSource && ageMs >= staleAfterMs && failedRunsForIssue.length > 0 && !hasActiveHeartbeat) {
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
        if (issue.originKind !== "mission_main_executor_unblock" && !issue.hiddenAt && !isTerminalIssueStatus(issue.status)) {
          await ownerActions.ensureMainExecutorUnblockIssue(mission, issue, {
            renewAfterNoActionWaiting: true,
            governanceEvidence: [
              `stale_todo_after_failed_run: ${label} is ${issue.status} after terminal heartbeat run ${latestFailedRun.id} status=${latestFailedRun.status}${latestFailedRun.errorCode ? ` errorCode=${latestFailedRun.errorCode}` : ""}${latestFailedRun.exitCode != null ? ` exitCode=${latestFailedRun.exitCode}` : ""}; no queued/running heartbeat run is active.`,
              "Preferred recovery boundary: choose retry_source_issue when the source issue is still non-terminal and assigned to the original executor; do not choose no_action_waiting merely because the issue is todo.",
            ],
          });
        }
      }
      if (isStaleQueueStatus && stepRowsForIssue.some((row) => row.stepRun.status === "pending") && runCount === 0 && ageMs >= staleAfterMs) {
        findings.push(`dispatch_omission: ${label} workflow step linked but heartbeat run_count=0 — ${issue.title}`);
      }
      if (issue.originKind === "mission_main_executor_unblock") {
        const toolRecovery = parseToolStepRecoveryMarker(issue.description);
        if (toolRecovery) {
          const canonicalIssue = findCanonicalToolStepRecoveryIssue({ marker: toolRecovery, missionIssues });
          if (canonicalIssue && canonicalIssue.id !== issue.id) {
            const closed = input.applyOwnerDecisionActions
              ? await ownerActions.closeDuplicateToolStepRecoveryIssue({
                  issue,
                  mission,
                  canonicalIssue,
                  runId: toolRecovery.runId,
                  stepId: toolRecovery.stepId,
                })
              : false;
            findings.push(closed
              ? `tool_step_recovery_duplicate_closed: ${label} canonical=${canonicalIssue.identifier ?? canonicalIssue.id} run=${toolRecovery.runId} step=${toolRecovery.stepId}`
              : `tool_step_recovery_duplicate_ignored: ${label} canonical=${canonicalIssue.identifier ?? canonicalIssue.id} run=${toolRecovery.runId} step=${toolRecovery.stepId}`);
            continue;
          }
        }
        // [수정시 영향] tool-step recovery 자동 retry 게이트. 이전엔 issue.status
        // === "done"(owner 가 수동으로 recovery issue 를 닫은 뒤) 일 때만 자동 retry 가
        // 동작했는데, owner 가 heartbeat 비활성/wakeOnDemand 로 recovery action 을
        // 고르지 않으면 issue 가 "done" 이 되지 않아 영원히 stall 했다(6h+ 사례).
        // status 조건을 제거하고 toolRecovery + applyOwnerDecisionActions 만으로 자동
        // retry 를 돌린다. 안전장치는 기존 그대로: hasNativeToolStepRetryAppliedMarker
        // 로 1회 cap, retry 실패 시 reopenAppliedToolStepRecoveryIfRetryFailed 가 issue
        // 를 다시 열어 owner 에게 넘긴다.
        if (toolRecovery && input.applyOwnerDecisionActions) {
          const markerInput = {
            ownerActionIssueId: issue.id,
            workflowRunId: toolRecovery.runId,
            stepId: toolRecovery.stepId,
          };
          const currentToolStepRow = stepRows.find((row) =>
            row.run.id === toolRecovery.runId && row.stepRun.stepId === toolRecovery.stepId
          );
          if (hasNativeToolStepRetryAppliedMarker(comments, markerInput)) {
            if (currentToolStepRow?.stepRun.status === "failed") {
              const reopened = await ownerActions.reopenAppliedToolStepRecoveryIfRetryFailed({
                issue,
                mission,
                runId: toolRecovery.runId,
                stepId: toolRecovery.stepId,
                stepRun: currentToolStepRow.stepRun,
              });
              findings.push(reopened
                ? `tool_step_recovery_retry_failed_reopened: ${label} run=${toolRecovery.runId} step=${toolRecovery.stepId}`
                : `tool_step_recovery_retry_failed: ${label} run=${toolRecovery.runId} step=${toolRecovery.stepId}`);
            } else {
              findings.push(`tool_step_recovery_already_applied: ${label} run=${toolRecovery.runId} step=${toolRecovery.stepId}`);
            }
          } else {
            const retryResult = await retryIssueLessToolWorkflowStep(db, {
              companyId: mission.companyId,
              runId: toolRecovery.runId,
              stepId: toolRecovery.stepId,
            });
            if (!retryResult) {
              findings.push(`tool_step_recovery_not_applied: ${label} run=${toolRecovery.runId} step=${toolRecovery.stepId} is not a retryable unified-engine issue-less tool step`);
            } else {
              findings.push(`tool_step_recovery_applied: ${label} run=${toolRecovery.runId} step=${toolRecovery.stepId} result=${retryResult.result.status}`);
              await issueService(db).addComment(
                issue.id,
                [
                  "### Native tool step retry applied",
                  buildNativeToolStepRetryAppliedMarker(markerInput),
                  `Workflow run: ${toolRecovery.runId}`,
                  `Step: ${toolRecovery.stepId}`,
                  `Step run: ${retryResult.stepRunId}`,
                  `Result status: ${retryResult.result.status}`,
                ].join("\n"),
                { agentId: mission.ownerAgentId },
              );
              appliedActions.push({
                type: "native_tool_step_retry",
                missionId: mission.id,
                ownerActionIssueId: issue.id,
                workflowRunId: toolRecovery.runId,
                stepId: toolRecovery.stepId,
                stepRunId: retryResult.stepRunId,
                resultStatus: retryResult.result.status,
              });
            }
          }
        }
        let ownerDecision = extractLatestMissionOwnerDecision(comments);
        if (ownerDecision?.decision === null) {
          findings.push(`owner_action_decision_invalid: ${label} has unsupported decision=${ownerDecision.invalidDecision} — ${issue.title}`);
          ownerDecision = null;
        } else if (!ownerDecision) {
          // [grace window] owner 가 recovery action 을 고르지 않은 채 오래되면 자동으로
          // retry_source_issue default 로 적용한다. owner 가 heartbeat 비활성/wakeOnDemand
          // 로 decision comment 를 안 쓰면 mission 이 무한 stall(6h+ 사례) 하므로, grace 가
          // 지나면 source issue 가 있을 때만 자동 retry. 이후 재실패 시 기존 reopen 경로가
          // 다시 owner 에게 넘긴다. side_effect 는 source retry 가 멱등 가정하에 안전.
          if (input.applyOwnerDecisionActions && issue.originId) {
            const ageMs = Date.now() - new Date(issue.createdAt).getTime();
            const GRACE_MS = 20 * 60 * 1000;
            if (ageMs >= GRACE_MS) {
              ownerDecision = {
                decision: "retry_source_issue",
                reason: `auto-default (owner grace ${GRACE_MS / 60000}min expired)`,
                sourceIssueRef: issue.originId,
              };
              findings.push(`owner_action_grace_default_retry: ${label} age=${Math.round(ageMs / 60000)}min — auto-defaulting retry_source_issue`);
            }
          }
        }
        if (ownerDecision) {
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
              if (input.applyOwnerDecisionActions) {
                const sourceIssueId = issue.originId;
                if (!sourceIssueId) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel, reason: "owner-action issue has no canonical originId source issue" }));
                  break;
                }
                const sourceCandidate = await db
                  .select()
                  .from(issues)
                  .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, mission.companyId)))
                  .limit(1)
                  .then((rows) => rows[0] ?? null);
                const sourceCandidateLabel = sourceCandidate ? (sourceCandidate.identifier ?? sourceCandidate.id) : sourceLabel;
                if (!sourceCandidate) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: "canonical source issue is missing or outside this company" }));
                  break;
                }
                if (sourceCandidate.missionId !== mission.id) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: "canonical source issue belongs to a different mission" }));
                  break;
                }
                if (sourceCandidate.hiddenAt) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: "canonical source issue is hidden" }));
                  break;
                }
                if (isTerminalIssueStatus(sourceCandidate.status)) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: `canonical source issue is already terminal status=${sourceCandidate.status}` }));
                  break;
                }
                const sourcePlanGateReason = activePlanRecoveryGateReason(
                  activePlan,
                  sourceCandidate,
                  stepRowsByIssueId.get(sourceCandidate.id) ?? [],
                );
                if (sourcePlanGateReason) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: sourcePlanGateReason }));
                  break;
                }
                const sourceRuns = heartbeatRunsByIssueId.get(sourceCandidate.id) ?? [];
                const sourceHasActiveHeartbeat = sourceRuns.some((run) => run.status === "queued" || run.status === "running");
                const sourceHasFailedRun = sourceRuns.some((run) => run.status === "failed" || run.status === "timed_out" || run.error || run.errorCode || (run.exitCode != null && run.exitCode !== 0));
                const sourceCorrectionEvidence = ownerActions.buildCorrectedArtifactValidatorRetryEvidence({
                  sourceIssue: sourceCandidate,
                  sourceLabel: sourceCandidateLabel,
                  missionIssues,
                  commentsByIssueId,
                });
                const sourceHasCompletedCorrectionEvidence = Boolean(sourceCorrectionEvidence);
                const sourceIsRetryableStaleQueue = (sourceCandidate.status === "todo" || sourceCandidate.status === "backlog")
                  && !sourceHasActiveHeartbeat
                  && (sourceHasFailedRun || sourceHasCompletedCorrectionEvidence);
                if (sourceCandidate.status !== "blocked" && !sourceIsRetryableStaleQueue) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: `canonical source issue is status=${sourceCandidate.status}, not blocked, stale queue after failed execution, or stale queue with completed correction evidence` }));
                  break;
                }
                const sourceComments = commentsByIssueId.get(sourceCandidate.id) ?? [];
                const markerInput = { ownerActionIssueId: issue.id, sourceIssueId: sourceCandidate.id, decision: "retry_source_issue" as const };
                const idempotencyKey = buildMissionOwnerDecisionWakeupIdempotencyKey({
                  missionId: mission.id,
                  ownerActionIssueId: issue.id,
                  sourceIssueId: sourceCandidate.id,
                });
                const wakeupMarkerInput = {
                  missionId: mission.id,
                  ownerActionIssueId: issue.id,
                  sourceIssueId: sourceCandidate.id,
                  decision: "retry_source_issue" as const,
                  idempotencyKey,
                };
                if (hasMissionOwnerDecisionAppliedMarker(sourceComments, markerInput)) {
                  if (input.dispatchOwnerDecisionWakeups && !hasMissionOwnerDecisionWakeupDispatchedMarker(sourceComments, wakeupMarkerInput)) {
                    let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = "skipped_no_assignee";
                    if (!sourceCandidate.assigneeAgentId) {
                      findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} source issue has no assignee; wakeup dispatch skipped`);
                    } else if (deps.onOwnerDecisionRetrySourceIssueApplied) {
                      try {
                        const wakeEvidenceComment = sourceCorrectionEvidence && !sourceComments.some((comment) => comment.includes("### Validator retry evidence") && comment.includes(sourceCorrectionEvidence.childIssueId))
                          ? await issueService(db).addComment(sourceCandidate.id, sourceCorrectionEvidence.comment, { agentId: mission.ownerAgentId })
                          : null;
                        const wakeupResult = await deps.onOwnerDecisionRetrySourceIssueApplied({
                          mission,
                          ownerActionIssue: issue,
                          sourceIssue: sourceCandidate,
                          targetAgentId: sourceCandidate.assigneeAgentId,
                          idempotencyKey,
                          wakeCommentId: wakeEvidenceComment?.id,
                        });
                        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
                        await issueService(db).addComment(
                          sourceCandidate.id,
                          buildRetrySourceIssueWakeupResultComment({
                            status: wakeupDispatchStatus,
                            missionId: mission.id,
                            ownerActionIssueId: issue.id,
                            ownerActionLabel: label,
                            sourceIssueId: sourceCandidate.id,
                            sourceLabel: sourceCandidateLabel,
                            targetAgentId: sourceCandidate.assigneeAgentId,
                            idempotencyKey,
                          }),
                          { agentId: mission.ownerAgentId },
                        );
                      } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        findings.push(`owner_action_wakeup_failed: ${sourceCandidateLabel} retry_source_issue wakeup callback failed — ${message}`);
                        wakeupDispatchStatus = "failed";
                      }
                    } else {
                      findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} dispatchOwnerDecisionWakeups enabled but no wakeup callback configured`);
                      wakeupDispatchStatus = "failed";
                    }
                    appliedActions.push({
                      type: "owner_decision_retry_source_issue",
                      missionId: mission.id,
                      ownerActionIssueId: issue.id,
                      sourceIssueId: sourceCandidate.id,
                      resultStatus: "todo",
                      wakeupDispatchStatus,
                      idempotencyKey,
                    });
                  } else {
                    findings.push(`owner_action_decision_already_applied: ${label} retry_source_issue source=${sourceCandidateLabel}`);
                  }
                  break;
                }
                let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchOwnerDecisionWakeups ? "skipped_no_assignee" : "not_requested";
                await db
                  .update(issues)
                  .set({ status: "todo", updatedAt: now })
                  .where(and(eq(issues.id, sourceCandidate.id), eq(issues.companyId, mission.companyId), inArray(issues.status, ["blocked", "todo", "backlog"]), isNull(issues.hiddenAt)));
                await issueService(db).addComment(
                  sourceCandidate.id,
                  buildRetrySourceIssueComment({
                    ownerActionIssueId: issue.id,
                    ownerActionLabel: label,
                    sourceIssueId: sourceCandidate.id,
                    sourceLabel: sourceCandidateLabel,
                    decisionReason: ownerDecision.reason,
                  }),
                  { agentId: mission.ownerAgentId },
                );
                if (input.dispatchOwnerDecisionWakeups) {
                  if (!sourceCandidate.assigneeAgentId) {
                    findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} source issue has no assignee; wakeup dispatch skipped`);
                    wakeupDispatchStatus = "skipped_no_assignee";
                  } else if (deps.onOwnerDecisionRetrySourceIssueApplied) {
                    try {
                      const wakeEvidenceComment = sourceCorrectionEvidence && !sourceComments.some((comment) => comment.includes("### Validator retry evidence") && comment.includes(sourceCorrectionEvidence.childIssueId))
                        ? await issueService(db).addComment(sourceCandidate.id, sourceCorrectionEvidence.comment, { agentId: mission.ownerAgentId })
                        : null;
                      const wakeupResult = await deps.onOwnerDecisionRetrySourceIssueApplied({
                        mission,
                        ownerActionIssue: issue,
                        sourceIssue: sourceCandidate,
                        targetAgentId: sourceCandidate.assigneeAgentId,
                        idempotencyKey,
                        wakeCommentId: wakeEvidenceComment?.id,
                      });
                      wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
                      await issueService(db).addComment(
                        sourceCandidate.id,
                        buildRetrySourceIssueWakeupResultComment({
                          status: wakeupDispatchStatus,
                          missionId: mission.id,
                          ownerActionIssueId: issue.id,
                          ownerActionLabel: label,
                          sourceIssueId: sourceCandidate.id,
                          sourceLabel: sourceCandidateLabel,
                          targetAgentId: sourceCandidate.assigneeAgentId,
                          idempotencyKey,
                        }),
                        { agentId: mission.ownerAgentId },
                      );
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      findings.push(`owner_action_wakeup_failed: ${sourceCandidateLabel} retry_source_issue wakeup callback failed — ${message}`);
                      wakeupDispatchStatus = "failed";
                    }
                  } else {
                    findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} dispatchOwnerDecisionWakeups enabled but no wakeup callback configured`);
                    wakeupDispatchStatus = "failed";
                  }
                }
                appliedActions.push({
                  type: "owner_decision_retry_source_issue",
                  missionId: mission.id,
                  ownerActionIssueId: issue.id,
                  sourceIssueId: sourceCandidate.id,
                  resultStatus: "todo",
                  wakeupDispatchStatus,
                  idempotencyKey,
                });
              }
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
        await ownerActions.ensureMainExecutorUnblockIssue(mission, issue);
        const body = comments.join("\n").toLowerCase();
        if (hasArtifactMissingSignal(body)) {
          const recurringIssues = await ownerActions.listRecurringArtifactMissingIssueRefs({
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
      const workflowSteps = (row.definition.stepsJson as WorkflowStep[] | null) ?? [];
      const workflowStep = workflowSteps.find((step) => step.id === row.stepRun.stepId) ?? null;
      if (isIssueLessToolWorkflowStep(workflowStep, row.stepRun.issueId)) {
        const workflowName = row.definition.name || row.run.workflowId;
        const recovery = await ownerActions.ensureToolStepFailureRecoveryIssue({
          mission,
          oversightIssue,
          run: row.run,
          stepRun: row.stepRun,
          step: workflowStep,
          workflowName,
        });
        const toolNamesLabel = recovery.toolNames.length > 0 ? recovery.toolNames.join(",") : "unknown";
        findings.push(`tool_step_failed_requires_recovery: run=${row.run.id} step=${row.stepRun.stepId} tool=${toolNamesLabel} class=${recovery.classification.className}${recovery.created ? " recovery_issue_created" : " recovery_issue_exists"}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: recovery.issue.id,
          sourceRef: {
            type: "native_workflow_run",
            id: row.run.id,
            workflowRunId: row.run.id,
            stepId: row.stepRun.stepId,
            issueId: null,
            pluginId: null,
            externalId: null,
          },
          reason: `Tool step ${row.stepRun.stepId} failed as ${recovery.classification.className}; main executor must diagnose tool logs/input/external state before retry`,
          safeToAutoApply: false,
        });
        continue;
      }
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
        if (unit.issueId) {
          const linkedIssue = missionIssueById.get(unit.issueId);
          if (linkedIssue && linkedIssue.originKind !== "mission_main_executor_unblock" && !linkedIssue.hiddenAt && !isTerminalIssueStatus(linkedIssue.status)) {
            await ownerActions.ensureMainExecutorUnblockIssue(mission, linkedIssue, { renewAfterNoActionWaiting: true });
          }
        }
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
      const paqoWorkflow = asRecord(refs.paqoWorkflow);
      const paqoWorkflowRunId = trimmedString(paqoWorkflow.workflowRunId);
      if (paqoWorkflowRunId) {
        planUnitKeys.add(`native_workflow_run:${paqoWorkflowRunId}`);
      }
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

    const ownerActionExplanations = await buildOwnerActionExplanations({
      ownerActionIssues: missionIssues
        .filter((issue) => issue.originKind === "mission_main_executor_unblock" && !issue.hiddenAt)
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          originKind: issue.originKind,
          originId: issue.originId,
        })),
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
        .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id), isNull(issues.hiddenAt)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      resolveSourceComments: async (sourceIssueId) => db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, sourceIssueId)))
        .then((rows) => rows.map((comment) => comment.body)),
    });

    const uniqueFindings = Array.from(new Set(findings));
    const materializePlanRecommendation = recommendations.find((recommendation) => (
      recommendation.type === "materialize_plan_decision" && recommendation.safeToAutoApply
    ));
    if (input.applySafeActions && materializePlanRecommendation) {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
        db,
        companyId: mission.companyId,
        missionId: mission.id,
        requestedBy: { actorType: "system", actorId: "mission-owner-supervision" },
      });
      const refs = asRecord(result.status === "recorded" ? result.missionPlanArtifact.refs : undefined);
      const paqoWorkflow = asRecord(refs.paqoWorkflow);
      appliedActions.push({
        type: "materialize_plan_decision",
        missionId: mission.id,
        resultStatus: result.status,
        planningIssueId: result.planningIssueId,
        ...(trimmedString(paqoWorkflow.workflowRunId) ? { workflowRunId: trimmedString(paqoWorkflow.workflowRunId)! } : {}),
      });
    }

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
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, ownerActionExplanations, commented: false };
    }

    const findingsSignature = createHash("sha256")
      .update(uniqueFindings.slice().sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    const markerText = `mission-owner-supervision:${mission.id}:${now.toISOString().slice(0, 13)}:${findingsSignature}`;
    if (oversightBodies.includes(markerText)) {
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, ownerActionExplanations, commented: false };
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
          ? appliedActions.map((action) => action.type === "dispatch_missing_step"
            ? `- ${action.type}: run=${action.workflowRunId} steps=${action.stepIds.join(",") || "n/a"} result=${action.resultStatus}`
            : action.type === "owner_decision_retry_source_issue"
              ? `- ${action.type}: owner_action=${action.ownerActionIssueId} source=${action.sourceIssueId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus ?? "n/a"}`
              : action.type === "native_tool_step_retry"
                ? `- ${action.type}: owner_action=${action.ownerActionIssueId} run=${action.workflowRunId} step=${action.stepId} step_run=${action.stepRunId} result=${action.resultStatus}`
                : action.type === "materialize_plan_decision"
                  ? `- ${action.type}: planning_issue=${action.planningIssueId ?? "n/a"} workflow_run=${action.workflowRunId ?? "n/a"} result=${action.resultStatus}`
                : `- ${action.type}: source=${action.sourceIssueId} failed_run=${action.failedRunId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus}`)
          : ["- None"]),
        "",
        "Main executor action:",
        "- Decide whether to dispatch/retry, recover, replan, escalate, or report impossible completion with evidence.",
        "- If the path changes, use this as a future replan path signal; no replan artifact is generated by this observation yet.",
      ].join("\n"),
      { agentId: mission.ownerAgentId },
    );

    return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, ownerActionExplanations, commented: true };
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
    applyOwnerDecisionActions?: boolean;
    dispatchOwnerDecisionWakeups?: boolean;
    dispatchStaleSourceIssueWakeups?: boolean;
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
              isNull(issues.hiddenAt),
              inArray(issues.status, ["todo", "backlog"]),
              lte(issues.createdAt, staleCutoff),
              inArray(heartbeatRuns.status, ["failed", "timed_out"]),
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
          : [],
      );
      const staleQueueIssueRows = rowMissionIds.length > 0
        ? await db
          .select({ missionId: issues.missionId, issueId: issues.id })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            isNull(issues.hiddenAt),
            inArray(issues.status, ["todo", "backlog"]),
            lte(issues.createdAt, staleCutoff),
            sql`${issues.originKind} not in ('mission_main_executor_oversight', 'mission_main_executor_unblock')`,
          ))
        : [];
      const staleOwnerActionIssueRows = rowMissionIds.length > 0
        ? await db
          .select({ missionId: issues.missionId, issueId: issues.id })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            isNull(issues.hiddenAt),
            inArray(issues.status, ["todo", "backlog"]),
            lte(issues.createdAt, staleCutoff),
            eq(issues.originKind, "mission_main_executor_unblock"),
          ))
        : [];
      const activeHeartbeatMissionIds = rowMissionIds.length > 0
        ? new Set((await db
          .select({ missionId: issues.missionId })
          .from(issues)
          .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            inArray(heartbeatRuns.status, ["queued", "running"]),
          )))
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId)))
        : new Set<string>();
      const staleInProgressFailedHeartbeatMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              eq(issues.status, "in_progress"),
              lte(issues.createdAt, staleCutoff),
              inArray(heartbeatRuns.status, ["failed", "timed_out"]),
              sql`${issues.originKind} not in ('mission_main_executor_oversight', 'mission_main_executor_unblock')`,
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
            .filter((missionId) => !activeHeartbeatMissionIds.has(missionId))
          : [],
      );
      const staleQueueNoActiveExecutionMissionIds = new Set(
        staleQueueIssueRows
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId))
          .filter((missionId) => !activeHeartbeatMissionIds.has(missionId)),
      );
      const stalledOwnerActionMissionIds = new Set(
        staleOwnerActionIssueRows
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId))
          .filter((missionId) => !activeHeartbeatMissionIds.has(missionId)),
      );

      for (const row of rows) {
        const snapshot = snapshots[row.id];
        const hasSupervisionUnit = snapshot?.units.some((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES.has(unit.status) && isActiveSupervisionExecutionStatus(unit.status));
        if (hasSupervisionUnit || staleFailedHeartbeatMissionIds.has(row.id) || staleQueueNoActiveExecutionMissionIds.has(row.id) || stalledOwnerActionMissionIds.has(row.id) || staleInProgressFailedHeartbeatMissionIds.has(row.id)) missionIds.push(row.id);
      }
    }

    const results: MissionOwnerSupervisionResult[] = [];
    for (const missionId of missionIds) {
      results.push(await runMainExecutorSupervision({
        missionId,
        staleAfterMinutes: input.staleAfterMinutes,
        now: input.now,
        applySafeActions: input.applySafeActions,
        applyOwnerDecisionActions: input.applyOwnerDecisionActions,
        dispatchOwnerDecisionWakeups: input.dispatchOwnerDecisionWakeups,
        dispatchStalledOwnerActionWakeups: true,
        dispatchStaleSourceIssueWakeups: input.dispatchStaleSourceIssueWakeups,
      }));
    }

    return { companyId: input.companyId, missionIds, missions: results };
  }
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

    return {
      ...mission,
      agents: agentRows.map((r: { row: typeof missionAgents.$inferSelect; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined })),
      ownerAgentName: ownerRow?.name,
      sessionBindings,
      activeMissionPlan: summarizeMissionPlanForRuntime(activeMissionPlan),
      ownerActionExplanations,
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

    const reconciledRows = await Promise.all(rows.map((mission) => ownerActions.reconcileMissionStatusFromWorkflowRuns(mission)));
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
    runMainExecutorSupervision,
    runActiveMissionOwnerSupervision,
  };
}

export type MissionService = ReturnType<typeof missionService>;
