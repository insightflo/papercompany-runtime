// server/src/services/missions/supervision.ts
//
// [파일 목적] mission owner supervision(감독/회복) 본체. runMainExecutorSupervision(1100+줄) +
//   runActiveMissionOwnerSupervision. missions.ts 클로저 분해(P3).
// [수정시 주의] 1100+줄 supervision 본체. 회귀 시 mission test + workflow-dag-engine test 필수.
import { heartbeatRuns, issueComments, issues, missions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { retryIssueLessToolWorkflowStep, syncWorkflowRunState, type WorkflowStep } from "../workflow/dag-engine.js";
import { findLatestAuthorizedMissionOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision } from "../mission-owner-plan-decisions.js";
import type { MissionRow } from "../missions.js";
import type { createOwnerActions } from "./owner-actions.js";
import type { MissionServiceDeps } from "../missions.js";
import { buildMissionOwnerDecisionWakeupIdempotencyKey, hasMissionOwnerDecisionAppliedMarker, hasMissionOwnerDecisionWakeupDispatchedMarker, hasStaleSourceIssueWakeupDispatchedMarker } from "./mission-owner-recovery-events.js";
import { buildOwnerActionExplanations } from "./mission-owner-recovery-explanations.js";
import { buildRetrySourceIssueComment, buildRetrySourceIssueWakeupResultComment, buildStaleSourceIssueWakeupDispatchedComment, extractLatestMissionOwnerDecision, isTerminalIssueStatus, summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js";
import { formatGovernanceThreadEvidenceLines, governanceThreadReasonSuffix } from "./mission-owner-recovery-governance-format.js";
import { isTerminalFailureStatus, listMissionExecutionSourceSnapshots, type MissionExecutionSourceRef, type MissionExecutionStatus } from "./mission-execution-sources.js";
import { normalizeMissionOwnerDecisionWakeupDispatchResult, type ActiveMissionOwnerSupervisionResult, type MissionOwnerDecisionWakeupDispatchStatus, type MissionOwnerSupervisionAppliedAction, type MissionOwnerSupervisionRecommendation, type MissionOwnerSupervisionResult } from "./supervision-types.js";
import { isTerminalMissionStatus } from "./shared-types.js";
import { activePlanRecoveryGateReason, asRecord, asRecordArray, buildNativeToolStepRetryAppliedMarker, executionUnitKey, executionUnitKeyFromSourceRef, findCanonicalToolStepRecoveryIssue, hasArtifactMissingSignal, hasDiagnosisSignal, hasNativeToolStepRetryAppliedMarker, hasRecoverableArtifactComment, isApprovalRuleMode, normalizedPlanStatus, parseToolStepRecoveryMarker, trimmedString, unitRequiresGovernedAction } from "./supervision-helpers.js";
import { isIssueLessToolWorkflowStep } from "./tool-step-failure.js";
import { buildMissionSupervisionContext } from "./mission-supervision-context.js";

export function createSupervision({ db, deps, ownerActions }: {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
}) {

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

  return {
    runMainExecutorSupervision,
    runActiveMissionOwnerSupervision,
  };
}
