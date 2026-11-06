// server/src/services/missions/supervision-main.ts
//
// [수정시 주의] main executor supervision 본체. 회귀 시 mission test + workflow-dag-engine test 필수.
// supervision.ts 의 createSupervision 안에 있던 중첩 함수 runMainExecutorSupervision 을 본문 변경 없이
// 그대로 옮긴 팩토리다. 클로저로 쓰던 qSvc / settleResolvedOwnerActionsAndFindOpenWork 는 deps 인자로 받는다.
import { agentWakeupRequests, issues, missions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { operatorApprovalWaitService } from "../operator-approval-wait.js";
import type { createOwnerActions } from "./owner-actions.js";
import { LIVE_WAKEUP_STATUSES } from "./owner-action-unblock-handback.js";
import type { MissionServiceDeps } from "../missions.js";
import { hasStructuredSourceRecoveryDecision, loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { acquireOwnerRetryLock, resolveOwnerRetryKey } from "./mission-owner-retry-identity.js";
import { applyAutomaticOwnerRetryIfClear, checkAutomaticOwnerRetryWait, isCapOverrideRetryCandidate,
  loadLatestFailureReasonCode, loadQaGateVerdictMap } from "./owner-retry-apply.js";
import {
  DEAD_TARGET_RETRY_BREAKER_THRESHOLD,
  countOwnerDecisionNotApplied,
  ensureDeadTargetHumanEscalation,
  recordOwnerDecisionNotApplied,
  type OwnerDecisionNotAppliedReasonCode,
} from "./mission-owner-dead-target-loop.js";
import { buildRetrySourceIssueComment, buildRetrySourceIssueRequestChangesContextComment, buildRetrySourceIssueWakeupResultComment, buildStaleSourceIssueWakeupDispatchedComment, extractLatestRequestChangesSummary, isTerminalIssueStatus, summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js";
import { formatGovernanceThreadEvidenceLines, governanceThreadReasonSuffix } from "./mission-owner-recovery-governance-format.js";
import { normalizeMissionOwnerDecisionWakeupDispatchResult, type MissionOwnerDecisionWakeupDispatchStatus, type MissionOwnerSupervisionAppliedAction, type MissionOwnerSupervisionRecommendation, type MissionOwnerSupervisionResult } from "./supervision-types.js";
import { isTerminalMissionStatus } from "./shared-types.js";
import { reconcileSupervisionMission } from "./supervision-lifecycle.js";
import { activePlanRecoveryGateReason, executionUnitKey, resolveProducerStepIdFromDag, type DagStepLike } from "./supervision-helpers.js";
import { runMissionPreLoopPhases } from "./supervision-pre-loop-phases.js";
import { runMissionPostLoopPhases } from "./supervision-post-loop-phases.js";
import { applyOwnerToolRecovery, type OwnerToolRecoveryOutcome } from "./owner-tool-recovery.js";
import { loadCompanySystemLanguage } from "./system-language.js";
import { buildMissionSupervisionContext } from "./mission-supervision-context.js";
import { requeueStaleValidationGateBeforeOwnerRetry } from "./validation-gate-requeue.js";
import { qualityService } from "../quality.js";
import { applyReassignSourceIssueDecision } from "./mission-owner-reassign-source.js";
import { applyOwnerReplanDecision } from "./owner-replan-application.js";
import { resolveRecoveryOwnership, isQaRecoveryLive } from "./recovery-ownership-guard.js";
import { authorizeProducerRework } from "./producer-rework-authorization.js";
import { createMissionWorkSettlement } from "./mission-work-settlement.js";
import { extractQaCapQaStepId, isQaReworkCapOversightIssue } from "./qa-rework-cap-oversight.js";
import { TERMINAL_FAILURE_RUN_STATUSES } from "./terminal-mission-human-operator-alert.js";
import {
  readWakeupResultDetailReason,
  resolveQaGateIssueId,
  loadActiveWorkProductUpdatedAt,
  hasRecoveryIdempotency,
  DISPATCHED_RECOVERY_WAKEUP_STATUSES,
  hasDispatchedRecoveryWakeup,
  recordRecoveryAction,
  claimSupervisionMarkerOnce,
  ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW,
  loadActiveSourceIssueWorkProducts,
} from "./supervision-support.js";

export function createRunMainExecutorSupervision({
  db,
  deps,
  ownerActions,
  qSvc,
  settleResolvedOwnerActionsAndFindOpenWork,
}: {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
  qSvc: ReturnType<typeof qualityService>;
  settleResolvedOwnerActionsAndFindOpenWork: ReturnType<typeof createMissionWorkSettlement>;
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
  }, promotedFromPlanning = false): Promise<MissionOwnerSupervisionResult> {
    const missionScope = await db
      .select()
      .from(missions)
      .where(eq(missions.id, input.missionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (missionScope) {
      if (input.applySafeActions === true) {
        const { terminal } = await reconcileSupervisionMission(db, ownerActions, missionScope);
        if (terminal) return terminal;
      }
      await settleResolvedOwnerActionsAndFindOpenWork(missionScope.companyId, input.missionId);
    }
    const context = await buildMissionSupervisionContext(db, { missionId: input.missionId });
    const {
      mission,
      missionIssues,
      missionIssueById,
      commentsByIssueId,
      heartbeatCountByIssueId,
      heartbeatRunsByIssueId,
      liveWakeupIssueIds,
      stepRows,
      stepRowsByIssueId,
      executionSnapshot,
      governanceThread,
      activePlan,
    } = context;
    const supervisionLanguage = await loadCompanySystemLanguage(db, mission.companyId);
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
    const recoveryOutcomes: OwnerToolRecoveryOutcome[] = [];
    const missionHasActiveHeartbeat = [...heartbeatRunsByIssueId.values()]
      .some((runs) => runs.some((run) => run.status === "queued" || run.status === "running"));

    // [owner on-duty monitoring] 활성 미션에 점검할 상황(진행 중 실행 단위 또는 열린 오너 액션)이 있으면
    //   일정 주기마다 오너를 깨워 미션 상황을 스스로 점검하게 한다. 사건별 깨움만으로는 오너가
    //   "지시 후 대기"에 머문다(2026-08-17 GAZ: 21시간 중 오너 자발 점검 0회). 버킷 멱등 클레임으로
    //   5분 스윕이 리뷰를 쌓지 않게 하고, 기존 하트비트 가드(동일 미션 중복/동시성 제한)가 과잉을 막는다.
    const MISSION_OWNER_PERIODIC_REVIEW_INTERVAL_MS = 30 * 60 * 1000;
    if (
      mission.status === "active"
      && deps.onMissionOwnerPeriodicReviewWakeRequested
      && (
        executionSnapshot.units.some((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW.has(unit.status))
        || missionIssues.some((row) =>
          row.hiddenAt == null
          && row.originKind === "mission_main_executor_unblock"
          && (row.status === "todo" || row.status === "in_progress" || row.status === "blocked"))
      )
    ) {
      const reviewBucket = Math.floor(now.getTime() / MISSION_OWNER_PERIODIC_REVIEW_INTERVAL_MS);
      const reviewKey = `mission-owner-periodic-review:${mission.id}:${reviewBucket}`;
      const claimed = await claimSupervisionMarkerOnce({
        db, companyId: mission.companyId, missionId: mission.id,
        issueId: oversightIssue.id,
        idempotencyKey: reviewKey, eventType: "mission_owner_periodic_review_wake",
        payload: { bucket: reviewBucket },
      });
      if (claimed) {
        const openOwnerActionIds = missionIssues
          .filter((row) => row.hiddenAt == null
            && row.originKind === "mission_main_executor_unblock"
            && (row.status === "todo" || row.status === "in_progress" || row.status === "blocked"))
          .map((row) => row.id);
        const inFlightUnitLabels = executionSnapshot.units
          .filter((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW.has(unit.status))
          .map((unit) => `${executionUnitKey(unit)}:${unit.status}`);
        try {
          await deps.onMissionOwnerPeriodicReviewWakeRequested({
            mission,
            openOwnerActionIds,
            inFlightUnitLabels,
            idempotencyKey: reviewKey,
          });
          findings.push(`mission_owner_periodic_review_wake_requested: open_owner_actions=${openOwnerActionIds.length} in_flight_units=${inFlightUnitLabels.length} bucket=${reviewBucket} — owner asked to review mission state and act (direct/coordinate/close) as needed`);
        } catch (err) {
          logger.warn({ err, missionId: mission.id }, "mission owner periodic review wake callback failed");
        }
      }
    }

    // [2a 분해] terminal report·QA cap·plan decision·work-product reuse wake 준비는
    //   supervision-pre-loop-phases.ts 의 runMissionPreLoopPhases 로 옮겼다(본문 이동만, 동작 동일).
    const {
      canonicalTerminalOwnerAction,
      terminalReportGroups,
      terminalReportGroupByTriggerIssueId,
      tryEmitTerminalReport,
      qaCapOwnerActionByWorkflowRunId,
      qaCapPendingWorkflowRunIds,
      qaCapSourceIssueIds,
      rejectedPlanningIssueId,
      planSubmissionMissingCandidate,
      tryDispatchWorkProductReuseWake,
    } = await runMissionPreLoopPhases({
      db,
      deps,
      ownerActions,
      qSvc,
      input,
      context,
      missionScope,
      promotedFromPlanning,
      supervisionLanguage,
      oversightIssue,
      findings,
      addRecommendation,
      appliedActions,
      missionHasActiveHeartbeat,
    });

    // [approval-waiting marker] 미션 이슈 전체에 대해 pending 운영자 결정/승인 대기 여부를
    // 배치 1회 판정한다 — 대기 중 이슈는 stale 이 아니라 사람 대기로 분류한다(스캔 N+1 금지).
    const approvalWaitByIssueId = await operatorApprovalWaitService(db).markersForIssueIds(
      missionIssues.map((issue) => issue.id),
    );

    for (const issue of missionIssues) {
      if (issue.id === oversightIssue.id) continue;
      if (issue.originKind === "mission_plan_qa") continue;
      const ageMs = now.getTime() - issue.createdAt.getTime();
      const label = issue.identifier ?? issue.id;
      const runCount = heartbeatCountByIssueId.get(issue.id) ?? 0;
      const runsForIssue = heartbeatRunsByIssueId.get(issue.id) ?? [];
      const comments = commentsByIssueId.get(issue.id) ?? [];
      const stepRowsForIssue = stepRowsByIssueId.get(issue.id) ?? [];
      const hasActiveHeartbeat = runsForIssue.some((run) => run.status === "queued" || run.status === "running");
      // [Phase D stopped-exclusion] 이 issue 가 live wakeup(queued/claimed/deferred_issue_execution/
      //   coalesced) 을 가지면 execution queue 에 진입한/진행 중인 작업이므로 stopped 가 아니다.
      //   live heartbeat run 과 OR 로 묶어 per-issue liveness 를 판정한다(mission-wide heuristic 대신).
      const hasLiveWake = liveWakeupIssueIds.has(issue.id);
      const issueLive = hasActiveHeartbeat || hasLiveWake;
      const failedRunsForIssue = runsForIssue.filter((run) => run.status === "failed" || run.status === "timed_out" || run.error || run.errorCode || (run.exitCode != null && run.exitCode !== 0));
      const isStaleQueueStatus = issue.status === "todo" || issue.status === "backlog";
      const isRecoverableQueueSource = isStaleQueueStatus && issue.originKind !== "mission_main_executor_unblock";
      const isStaleInProgressSource = issue.status === "in_progress" && issue.originKind !== "mission_main_executor_unblock";
      // [approval-waiting marker] pending 결정/승인이 있으면 사람 대기 — stale 판정에서 면제한다.
      const operatorApprovalWait = approvalWaitByIssueId.get(issue.id);
      const isWaitingOnOperatorApproval = operatorApprovalWait?.waiting === true;
      const isRejectedPlanningIssue = issue.originKind === "mission_main_executor_plan" && issue.id === rejectedPlanningIssueId;
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

      if (isStaleInProgressSource && ageMs >= staleAfterMs && !issueLive && !isWaitingOnOperatorApproval) {
        const latestFailedRun = failedRunsForIssue
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (!latestFailedRun) {
          findings.push(`stale_in_progress_no_execution: ${label} is in_progress but has no heartbeat run and no live wakeup/queue evidence — ${issue.title}`);
          addRecommendation({
            type: "retry_unit_if_safe",
            missionId: mission.id,
            issueId: issue.id,
            reason: `Source issue ${label} is in_progress with no execution record; owner must diagnose and recover through the native workflow path`,
            safeToAutoApply: false,
          });
          addRecommendation({
            type: "request_replan",
            missionId: mission.id,
            issueId: issue.id,
            reason: `Mission source ${label} is marked in_progress without a live run or queue request; owner should recover, replan, or escalate`,
            safeToAutoApply: false,
          });
          if (!issue.hiddenAt && !isTerminalIssueStatus(issue.status)) {
            await ownerActions.ensureMainExecutorUnblockIssue(mission, issue, {
              renewAfterNoActionWaiting: true,
              governanceEvidence: [
                `stale_in_progress_no_execution: ${label} is in_progress but has no heartbeat run or live wakeup request.`,
                "Recovery boundary: Unblock must report evidence to Oversight; only the native workflow layer may resume a proven workflow step.",
              ],
            });
          }
        }
        if (latestFailedRun && !issueLive) {
          const idempotencyKey = `mission-stale-source-wakeup:${mission.id}:${issue.id}:${latestFailedRun.id}`;
          const alreadyDispatched = await hasRecoveryIdempotency(db, mission.companyId, idempotencyKey);
          let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchStaleSourceIssueWakeups ? "skipped_no_assignee" : "not_requested";
          let wakeCommentId: string | undefined;
          const hasSourceDiagnosis = await hasStructuredSourceRecoveryDecision({ db, companyId: mission.companyId, sourceIssueId: issue.id });
          // [P3 주의] stale-source 경로의 issue.originId 는 보통 workflow run id(QA issue id 아님)라
          //   resolveQaGateIssueId 가 no-op. 정확한 QA gate derive 가 필요하므로 이 삽입점은 제거
          //   (잘못된 차단 방지). QA recovery ownership 차단은 retry case(unblock issue, originId=source)에서 처리.
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
                  buildStaleSourceIssueWakeupDispatchedComment({ language: supervisionLanguage,
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

      // [approval-waiting marker] 사람 대기 중인 in_progress 이슈는 stale 오판 대신
      // 대기 사실을 관찰 가능한 파인딩으로 남긴다(회복 이슈 생성/재시도 추천 없음).
      if (isStaleInProgressSource && ageMs >= staleAfterMs && !issueLive && isWaitingOnOperatorApproval) {
        findings.push(
          `operator_approval_waiting: ${label} is in_progress and waiting on a pending operator decision/approval` +
            ` (decisions=${operatorApprovalWait?.operatorDecisionIds.join(",") || "none"}, approvals=${operatorApprovalWait?.approvalIds.join(",") || "none"}) — not stale — ${issue.title}`,
        );
      }

      if (input.dispatchStalledOwnerActionWakeups && issue.originKind === "mission_main_executor_unblock" && isStaleQueueStatus && ageMs >= staleAfterMs && !issueLive) {
        const sourceIssue = issue.originId ? missionIssueById.get(issue.originId) : null;
        const sourceLabel = sourceIssue ? (sourceIssue.identifier ?? sourceIssue.id) : (issue.originId ?? "unknown-source");
        const latestFailedRun = failedRunsForIssue
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        if (runsForIssue.length === 0) {
          findings.push(`owner_action_stalled_no_execution: ${label} ${issue.status} is an owner unblock action for ${sourceLabel} but has no heartbeat run and no mission issue has queued/running execution — ${issue.title}`);
        } else if (latestFailedRun && !issueLive) {
          findings.push(`owner_action_stalled_after_failed_run: ${label} ${issue.status} is an owner unblock action for ${sourceLabel} after failed heartbeat run=${latestFailedRun.id} status=${latestFailedRun.status}${latestFailedRun.errorCode ? ` errorCode=${latestFailedRun.errorCode}` : ""}${latestFailedRun.exitCode != null ? ` exitCode=${latestFailedRun.exitCode}` : ""}; no mission issue has queued/running execution — ${issue.title}`);
        }
        if ((runsForIssue.length === 0 || latestFailedRun) && !issueLive) {
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

      if (isRecoverableQueueSource && ageMs >= staleAfterMs && !issueLive && failedRunsForIssue.length === 0) {
        // [AREA: wakeup queue / Phase 1.5] 같은 issue 에 pending 실행요청(status=queued, runId null)이
        // 있으면 "멈춤(stale)"이 아니라 엔진 승급을 기다리는 "대기" 상태다. 단 요청이 queue TTL 초과로
        // 오래됐으면 promotion 이 막힌 진짜 stale 로 본다(mission_run_active 가 풀렸는데도 안 올라간 경우 등).
        const pendingQueuedWakeup = await db
          .select({ id: agentWakeupRequests.id, requestedAt: agentWakeupRequests.requestedAt })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, mission.companyId),
            eq(agentWakeupRequests.status, "queued"),
            sql`${agentWakeupRequests.runId} is null`,
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
          ))
          .limit(1);
        const queueTtlMs = staleAfterMs * 4;
        const pendingWakeupAgeMs = pendingQueuedWakeup[0] ? now.getTime() - pendingQueuedWakeup[0].requestedAt.getTime() : null;
        const isWaitingOnQueue = pendingWakeupAgeMs !== null && pendingWakeupAgeMs < queueTtlMs;

        if (isWaitingOnQueue) {
          findings.push(`queued_waiting_for_execution: ${label} ${issue.status} has a pending execution-request (wakeup queue, age=${Math.round((pendingWakeupAgeMs ?? 0) / 1000)}s); waiting for engine promotion, not stale — ${issue.title}`);
          addRecommendation({
            type: "retry_unit_if_safe",
            missionId: mission.id,
            issueId: issue.id,
            reason: `Queued issue ${label} is waiting on a pending execution-request (wakeup queue); give the engine time to promote before retry/re-dispatch`,
            safeToAutoApply: false,
          });
        } else {
          findings.push(`stale_todo_no_active_execution: ${label} ${issue.status} while no mission issue has queued/running execution${pendingWakeupAgeMs !== null ? `; pending queue request aged past TTL (${Math.round((pendingWakeupAgeMs ?? 0) / 1000)}s)` : ""} — ${issue.title}`);
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
      }
      if (isRecoverableQueueSource && ageMs >= staleAfterMs && failedRunsForIssue.length > 0 && !issueLive) {
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
        const toolRecovery = await applyOwnerToolRecovery({ db, mission, issue,
          sourceIssue: issue.originId ? missionIssueById.get(issue.originId) ?? null : null,
          stepRows, apply: Boolean(input.applyOwnerDecisionActions) });
        if (toolRecovery) {
          recoveryOutcomes.push(toolRecovery.outcome);
          if (toolRecovery.appliedAction) appliedActions.push(toolRecovery.appliedAction);
          // [dead-target circuit breaker — 2026-10-18 사고] tool recovery 카드가 있는데 결정에 tool-step
          //   recoveryTarget 이 없으면 no_op(target_missing, requires_decision) 이 매 틱 반복되며 감시를
          //   무한 대기시킨다(라이브 관측: RES-8604, 17h+). 같은 조합이 3회 반복되면 재노출을 억제하고
          //   사람 결정 카드로 1회 에스컬레이션한다. 다른 no_op 사유는 기존 진단 그대로 유지한다.
          if (toolRecovery.outcome.kind === "no_op" && toolRecovery.outcome.reason === "target_missing") {
            const toolLoopKey = "tool_recovery_target_missing";
            const toolDeadTargetId = issue.originId ?? "none";
            // [2단계 — 실행 불가 회복 카드 즉시 승격 2026-10-23] 결정이 이미 기록됐는데 도구 단계 대상이
            //   없으면(죽은 결정) 회복 카드의 전제가 소멸했다 — 오너가 다음 틱에 대상을 보완할 가능성만
            //   기다리며 no_op 를 재기록·재노출하는 것은 무한 대기 루프다(라이브 관측: RES-8604 17h+,
            //   2026-10-23 RES-9071 3회 반복). 즉시 1회 사람 에스컬레이션으로 전환한다. 결정 자체가 없는
            //   대기는 오너 응답 대기이므로 기존 3회 브레이컈를 그대로 쓴다.
            const hasRecordedDecision = toolRecovery.outcome.decisionEventId != null;
            const priorToolNoOp = hasRecordedDecision ? DEAD_TARGET_RETRY_BREAKER_THRESHOLD : await countOwnerDecisionNotApplied(db, {
              companyId: mission.companyId, ownerActionIssueId: issue.id,
              decision: toolLoopKey, sourceIssueId: toolDeadTargetId,
              decisionEventId: toolRecovery.outcome.decisionEventId ?? "auto",
            });
            if (priorToolNoOp >= DEAD_TARGET_RETRY_BREAKER_THRESHOLD) {
              const immediateDeadDecision = hasRecordedDecision;
              const escalation = await ensureDeadTargetHumanEscalation(db, {
                companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                loopKey: toolLoopKey,
                anchors: [issue, oversightIssue],
                ownerActionIssueId: issue.id, sourceIssueId: issue.originId,
                reason: immediateDeadDecision
                  ? `Tool recovery owner action ${label} has a recorded decision without an explicit tool-step recovery target (dead target) — waiting for the owner to patch it re-exposes the same no_op every supervision tick, an infinite decision-wait loop. Escalating immediately; choose replan, an explicit recovery target, or cancel this recovery.`
                  : `Tool recovery owner action ${label} has repeated no_op(target_missing) ${priorToolNoOp} times: the recovery card requires an explicit tool-step recovery target but the owner decision has not arrived. Re-exposing the same no_op every supervision tick is an infinite decision-wait loop.`,
                evidence: `owner-action=${label} reason=target_missing ${immediateDeadDecision ? "dead-recorded-decision" : `repeats=${priorToolNoOp}`} supervisionTick=${now.toISOString()}`,
              });
              findings.push(`owner_tool_recovery_dead_target_breaker: ${label} tool recovery no_op(target_missing) ${immediateDeadDecision ? "dead recorded decision — escalated immediately" : `repeated ${priorToolNoOp}x`} — further no-op re-exposure suppressed; human decision card=${escalation.ensured ? "ensured" : `skipped(${escalation.reason})`}. Loop escape: record a decision with an explicit tool-step recovery target, replan, or cancel this recovery`);
              addRecommendation({
                type: "escalate_blocked",
                missionId: mission.id,
                issueId: issue.id,
                reason: `Tool recovery ${label} waits forever on a missing tool-step recovery target (${priorToolNoOp} repeated no_op); a human must choose replan, an explicit recovery target, or cancellation`,
                safeToAutoApply: false,
              });
              continue;
            }
            if (!hasRecordedDecision) {
              // 결정 자체가 없는 대기만 no_op 로 기록한다(기존 3회 브레이컈 대상).
              await recordOwnerDecisionNotApplied(db, {
                companyId: mission.companyId, missionId: mission.id, ownerActionIssueId: issue.id,
                decision: toolLoopKey, sourceIssueId: toolDeadTargetId,
                decisionEventId: toolRecovery.outcome.decisionEventId ?? "auto",
                reason: "tool recovery card present but decision has no tool-step recovery target",
                reasonCode: "tool_target_missing", occurredAt: now,
              });
            }
          }
          findings.push(`tool_step_recovery_${toolRecovery.outcome.kind}: ${label} reason=${toolRecovery.outcome.reason}`);
          // Missing/stale/consumed tool targets never fall through to generic issue retry.
          continue;
        }
        // [structured authority] 자연어 comment parsing 제거 — loadLatestMissionOwnerDecision 만 권위.
        //   [P6 hybrid guard] AUTO(owner 미결정 grace default) rework 인지, 그리고 이 미션이 native loop(back-edge) 를
        //   가지는지 — 둘 다 참이면 P4 loop-driver 가 QA-reject producer rework 를 이미 담당하므로 supervision 중복 skip.
        const decisionRecord = await loadLatestMissionOwnerDecision({
          db,
          companyId: mission.companyId,
          ownerActionIssueId: issue.id,
        });
        let ownerDecision = decisionRecord
          && decisionRecord.missionId === mission.id
          && decisionRecord.authorAgentId === mission.ownerAgentId
          ? decisionRecord.decision
          : null;
        let autoDefaulted = false;
        let missionHasNativeLoop = false;
        if (!ownerDecision) {
          // [Patch 2 cap-exhausted] QA rework cap oversight issues must NOT be grace-defaulted.
          //   Wait for explicit structured owner decision — no auto-retry, no grace-default.
          if (isQaReworkCapOversightIssue(issue.description)) {
            findings.push(`qa_rework_cap_oversight_pending_decision: ${label} — explicit structured owner decision required, no grace-default`);
            continue;
          }
          // [grace window] owner 가 recovery action 을 고르지 않은 채 오래되면 자동으로
          // retry_source_issue default 로 적용한다. owner 가 heartbeat 비활성/wakeOnDemand
          // 로 structured decision 을 안 쓰면 mission 이 무한 stall 하므로, grace 가
          // 지나면 source issue 가 있을 때만 자동 retry. 이후 재실패 시 기존 reopen 경로가
          // 다시 owner 에게 넘긴다.
          if (input.applyOwnerDecisionActions && issue.originId) {
            const ageMs = Date.now() - new Date(issue.createdAt).getTime();
            const GRACE_MS = 20 * 60 * 1000;
            if (ageMs >= GRACE_MS) {
              // [dead-target grace guard — 2026-10-18 사고] 자동 retry default 를 고르기 전에 대상
              //   실행 가능성을 본다. 캐노니컬 소스가 종결/숨김/누락(그리고 DAG producer 재시도 대체도
              //   없으면) 같은 죽은 대상을 매 틱 반복 지정하는 no-op 순환이므로 retry 대신 escalate 로
              //   자동 전환하고 사람 결정 카드를 1회 보증한다. 살아있는 대상은 기존 retry default 유지.
              const graceSource = missionIssueById.get(issue.originId) ?? null;
              const graceSourceNotRetryable = !graceSource
                || Boolean(graceSource.hiddenAt)
                || (isTerminalIssueStatus(graceSource.status)
                  && (stepRowsByIssueId.get(issue.originId) ?? []).length === 0);
              const gracePriorNotApplied = graceSourceNotRetryable
                ? await countOwnerDecisionNotApplied(db, {
                  companyId: mission.companyId, ownerActionIssueId: issue.id,
                  decision: "retry_source_issue", sourceIssueId: issue.originId,
                  decisionEventId: "auto",
                })
                : 0;
              if (graceSourceNotRetryable || gracePriorNotApplied >= DEAD_TARGET_RETRY_BREAKER_THRESHOLD) {
                const graceSourceLabel = graceSource ? (graceSource.identifier ?? graceSource.id) : issue.originId;
                const escalation = await ensureDeadTargetHumanEscalation(db, {
                  companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                  loopKey: "retry_source_issue",
                  anchors: [issue, oversightIssue],
                  ownerActionIssueId: issue.id, sourceIssueId: issue.originId,
                  reason: `Auto-defaulted retry_target for owner action ${label} points at ${graceSourceLabel}, which is ${graceSource ? (graceSource.hiddenAt ? `hidden` : `terminal status=${graceSource.status}`) : "missing from this mission"}. Retrying it can never be applied, so the auto-default switched to escalate instead of repeating a no-op retry every supervision tick.`,
                  evidence: `owner-action=${label} target=${graceSourceLabel} targetStatus=${graceSource?.status ?? "missing"} priorNotApplied=${gracePriorNotApplied} graceAgeMin=${Math.round(ageMs / 60000)}`,
                });
                autoDefaulted = true;
                ownerDecision = {
                  decision: "escalate",
                  reason: `auto-default (owner grace ${GRACE_MS / 60000}min expired; retry target ${graceSourceLabel} is not actionable — escalate to human)`,
                  sourceIssueRef: issue.originId,
                };
                findings.push(`owner_action_grace_default_dead_target: ${label} source=${graceSourceLabel} is not actionable (${graceSource ? (graceSource.hiddenAt ? "hidden" : `terminal status=${graceSource.status}`) : "missing"}${(stepRowsByIssueId.get(issue.originId) ?? []).length > 0 ? "; producer-rework candidates exist so application decides" : ""}, prior not_applied=${gracePriorNotApplied}) — auto-default switched retry_source_issue to escalate; human decision card=${escalation.ensured ? "ensured" : `skipped(${escalation.reason})`}. Loop escape: replan, retry a live source, or cancel this recovery`);
              } else {
                const graceWait = await checkAutomaticOwnerRetryWait(db, {
                  companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                  ownerActionIssueId: issue.id, ownerActionStatus: issue.status,
                  originalSourceIssueId: issue.originId, retryIssueId: issue.originId,
                });
                if (graceWait.kind !== "clear") {
                  findings.push(`owner_action_grace_default_waiting: ${label} exact human wait=${graceWait.kind}${graceWait.kind === "unresolved" ? ` reason=${graceWait.reasonCode}` : ` bindings=${graceWait.bindingIds.join(",")}`}`);
                  continue;
                }
                autoDefaulted = true;
                ownerDecision = {
                  decision: "retry_source_issue",
                  reason: `auto-default (owner grace ${GRACE_MS / 60000}min expired)`,
                  sourceIssueRef: issue.originId,
                };
                findings.push(`owner_action_grace_default_retry: ${label} age=${Math.round(ageMs / 60000)}min — auto-defaulting retry_source_issue`);
              }
            }
          }
        }
        if (ownerDecision) {
          const sourceIssue = issue.originId ? (missionIssueById.get(issue.originId) ?? null) : null;
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
                const releaseRetryLock = await acquireOwnerRetryLock(db, mission.companyId, issue.id);
                if (!releaseRetryLock) break;
                try {
                const currentDecision = await loadLatestMissionOwnerDecision({ db, companyId: mission.companyId, ownerActionIssueId: issue.id });
                if (currentDecision?.eventId !== decisionRecord?.eventId || (!autoDefaulted && (currentDecision?.missionId !== mission.id || currentDecision?.authorAgentId !== mission.ownerAgentId))) break;
                // [P3 QA recovery ownership gate] QA recovery chain 이 live/stalled 면 producer reopen·
                //   mission_owner_retry_source_issue wakeup·source 상태변경 전부 금지(req 1/2, codex 계약 2).
                //   stalled(QA recovery deadlock)도 producer 재시도 ❌ — 일반 owner-action/replan 경로로 넘김.
                //   oversight_may_act(chain 없음/terminal+verdict)만 기존 retry 처리 진행.
                if (issue.originId) {
                  const qaGateIssueId = resolveQaGateIssueId({ originId: issue.originId, missionIssueById, stepRowsByIssueId });
                  if (qaGateIssueId) {
                    const ownership = await resolveRecoveryOwnership(db, {
                      companyId: mission.companyId,
                      missionId: mission.id,
                      sourceIssueId: issue.originId,
                      qaGateIssueId,
                    });
                    if (isQaRecoveryLive(ownership)) {
                      const detail = `signal=${ownership.signal}`;
                      findings.push(`owner_action_qa_recovery_owned: ${label} decision=retry_source_issue source=${sourceLabel} ownership=${ownership.kind} ${detail} — observe-only, producer reopen/wakeup/state-change forbidden`);
                      break;
                    }
                  }
                }
                // Structured fields only — nextAction free text is never producer-target authority.
                const ownerReworkRef = ownerDecision.reworkTargetRef ?? null;
                let sourceIssueId: string | null = null;
                let automaticProducerIdentity: { originStepRunId: string; producerStepRunId: string } | null = null;
                const resolveOwnerIssueRef = (ref: string | null | undefined) => {
                  if (!ref) return null;
                  const target = missionIssues.find((mi) => (mi.identifier ?? null) === ref || mi.id === ref) ?? null;
                  return target && target.missionId === mission.id && !target.hiddenAt ? target.id : null;
                };
                if (ownerDecision.recoveryTarget?.kind === "issue") {
                  sourceIssueId = resolveOwnerIssueRef(ownerDecision.recoveryTarget.issueId);
                  if (!sourceIssueId || [ownerReworkRef, ownerDecision.sourceIssueRef].some((ref) => ref && resolveOwnerIssueRef(ref) !== sourceIssueId)) {
                    findings.push(`owner_action_target_conflict: ${label} — explicit target invalid or conflicting; no fallback`);
                    break;
                  }
                } else sourceIssueId = resolveOwnerIssueRef(ownerReworkRef);
                // AUTO grace default 의 sourceIssueRef 는 origin(QA) 이므로 producer rework 해석을 막지 않도록 skip.
                if (!sourceIssueId && !autoDefaulted) {
                  sourceIssueId = resolveOwnerIssueRef(ownerDecision.sourceIssueRef);
                }
                let producerReworkResolved = false;
                // Explicit targets never fall back to description-derived producer identity.
                // [Patch 2 cap-exhausted] producer rework budget. 기본 true = budget 을 알 수 없으면 기존 동작(skip) 유지.
                //   producer 를 찾은 경우에만 iterationIndex vs max(producer back-edge maxIterations) 으로 계산한다.
                let producerBudgetRemaining = true;
                if (!sourceIssueId && issue.originId) {
                  const originStepRows = stepRowsByIssueId.get(issue.originId) ?? [];
                  const originStepId = originStepRows.map((row) => row.stepRun.stepId).find((id) => Boolean(id)) ?? null;
                  const dagSteps = (originStepRows[0]?.definition?.stepsJson ?? null) as DagStepLike[] | null;
                  missionHasNativeLoop = Array.isArray(dagSteps) && dagSteps.some((step) => {
                    const edges = (step as { conditionalDependencies?: unknown }).conditionalDependencies;
                    return Array.isArray(edges) && edges.some((edge) => (edge as { isBackEdge?: boolean } | null)?.isBackEdge === true);
                  });
                  if (originStepId && Array.isArray(dagSteps) && dagSteps.length > 0) {
                    const producerStepId = resolveProducerStepIdFromDag(originStepId, dagSteps);
                    if (producerStepId) {
                      const producerRow = stepRows.find((row) => row.stepRun.stepId === producerStepId && row.stepRun.issueId) ?? null;
                      if (producerRow?.stepRun.issueId) {
                        sourceIssueId = producerRow.stepRun.issueId;
                        producerReworkResolved = true;
                        const originStepRun = originStepRows[0]?.stepRun;
                        if (originStepRun?.id) automaticProducerIdentity = {
                          originStepRunId: originStepRun.id, producerStepRunId: producerRow.stepRun.id,
                        };
                        // [Patch 2 cap-exhausted] native loop 의 rework budget = producer iterationIndex vs
                        //   producer back-edge 들의 maxIterations 최댓값(loop-driver 가 쓰는 producer-level cap 과 동일 기준).
                        const producerIters = producerRow.stepRun.iterationIndex ?? 0;
                        const producerStepDef = (dagSteps as DagStepLike[]).find((s) => (s as { id?: string }).id === producerStepId) ?? null;
                        const backEdges = (producerStepDef as { conditionalDependencies?: Array<{ isBackEdge?: boolean; maxIterations?: number }> } | null)?.conditionalDependencies ?? [];
                        const producerMaxIters = backEdges
                          .filter((e) => e.isBackEdge === true && typeof e.maxIterations === "number")
                          .reduce((max, e) => Math.max(max, e.maxIterations ?? 0), 0);
                        producerBudgetRemaining = producerMaxIters > producerIters;
                      }
                    }
                  }
                }
                // legacy: 어느 쪽도 못 구하면 origin(QA 자체 재시도의 기존 동작)으로 돌아간다.
                if (!sourceIssueId) sourceIssueId = issue.originId ?? null;
                const isProducerRework = producerReworkResolved || (issue.originId !== null && sourceIssueId !== issue.originId);
                // [P6 hybrid guard] native-loop 미션의 AUTO(owner 미결정 grace default) producer-rework 는 P4 loop-driver
                //   가 QA-reject rework 를 이미 담당(maxIterations cap + iteration_index/attempts 추적)하므로 supervision 이
                //   중복 재오픈/상충하지 않게 skip. owner-명시 rework(autoDefaulted=false)는 유지 — owner 수동 제어권 보존.
                //   [Patch 2 cap-exhausted] 단, rework budget 이 남아있을 때만 skip. cap exhausted (iterationIndex >=
                //   maxIterations) 이후엔 native loop 가 더 이상 rework 를 담당하지 않으므로 skip 을 풀고 owner action/replan
                //   경로로 넘긴다(fall-through → 기존 owner-action 생성 라인으로 진입).
                if (autoDefaulted && isProducerRework && missionHasNativeLoop && producerBudgetRemaining) {
                  findings.push(`owner_action_skipped_native_loop: ${label} AUTO producer-rework deferred — QA-reject rework owned by native loop(P4), budget remaining. source=${sourceLabel}`);
                  break;
                }
                if (autoDefaulted && isProducerRework && missionHasNativeLoop && !producerBudgetRemaining) {
                  findings.push(`owner_action_native_loop_cap_exhausted: ${label} producer rework cap exhausted — native loop no longer owns rework; routing to owner action/replan. source=${sourceLabel}`);
                }
                // [dead-target circuit breaker — 2026-10-18 사고] 같은 (owner-action, retry_source_issue,
                //   대상, 결정이벤트) 조합이 구조적 사유(원천 없음/미발견/타 미션/숨김/종결)로 이미 N번
                //   not_applied 였다면 같은 거부를 매 틱 반복하지 않는다 — 재적용을 억제하고 루프 탈출
                //   안내 + 사람 결정 카드(1회)로 전환한다. owner 가 새 결정(새 eventId)을 기록하면 카운트가
                //   초기화되어 즉시 다시 평가된다(수동 결정 자유 불변). 대상이 살아나면 이 사유family 자체가
                //   발생하지 않으므로 살아있는 대상 재시도는 영향 없다.
                const deadTargetDecisionEventId = decisionRecord?.eventId ?? "auto";
                const handleDeadTargetNotApplied = async (
                  reasonCode: OwnerDecisionNotAppliedReasonCode,
                  reason: string,
                  markerTargetId: string,
                  deadLabel: string,
                ): Promise<void> => {
                  const priorNotAppliedCount = await countOwnerDecisionNotApplied(db, {
                    companyId: mission.companyId, ownerActionIssueId: issue.id,
                    decision: "retry_source_issue", sourceIssueId: markerTargetId,
                    decisionEventId: deadTargetDecisionEventId,
                  });
                  if (priorNotAppliedCount >= DEAD_TARGET_RETRY_BREAKER_THRESHOLD) {
                    const escalation = await ensureDeadTargetHumanEscalation(db, {
                      companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                      loopKey: "retry_source_issue",
                      anchors: [issue, oversightIssue],
                      ownerActionIssueId: issue.id, sourceIssueId: markerTargetId === "none" ? null : markerTargetId,
                      reason: `Owner retry_source_issue decision for ${label} targets ${deadLabel}, which has been rejected as unusable (dead target) ${priorNotAppliedCount} times (${reason}). Re-applying the same decision every supervision tick is an infinite no-op loop with no execution and no escalation.`,
                      evidence: `owner-action=${label} decision=retry_source_issue target=${deadLabel} notAppliedCount=${priorNotAppliedCount} lastReason=${reason}`,
                    });
                    findings.push(`owner_action_retry_dead_target_breaker: ${label} decision=retry_source_issue source=${deadLabel} not_applied=${priorNotAppliedCount}x (${reason}) — further re-application suppressed; human decision card=${escalation.ensured ? "ensured" : `skipped(${escalation.reason})`}. Loop escape: replan_mission, retry a live source, or cancel this recovery`);
                    addRecommendation({
                      type: "request_replan",
                      missionId: mission.id,
                      issueId: issue.id,
                      reason: `Retry target ${deadLabel} was rejected ${priorNotAppliedCount} times (dead target); owner must replan or pick a live source instead of repeating the same retry`,
                      safeToAutoApply: false,
                    });
                    addRecommendation({
                      type: "escalate_blocked",
                      missionId: mission.id,
                      issueId: issue.id,
                      reason: `Retry target ${deadLabel} is not actionable; repeated retry_source_issue application is suppressed by the dead-target circuit breaker and needs a human decision`,
                      safeToAutoApply: false,
                    });
                    return;
                  }
                  await recordOwnerDecisionNotApplied(db, {
                    companyId: mission.companyId, missionId: mission.id, ownerActionIssueId: issue.id,
                    decision: "retry_source_issue", sourceIssueId: markerTargetId,
                    decisionEventId: deadTargetDecisionEventId,
                    reason, reasonCode, occurredAt: now,
                  });
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: deadLabel, reason }));
                };
                if (!sourceIssueId) {
                  await handleDeadTargetNotApplied("source_unresolvable", "owner-action issue has no canonical originId source issue", "none", sourceLabel);
                  break;
                }
                let sourceCandidate = await db
                  .select()
                  .from(issues)
                  .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, mission.companyId)))
                  .limit(1)
                  .then((rows) => rows[0] ?? null);
                let sourceCandidateLabel = sourceCandidate ? (sourceCandidate.identifier ?? sourceCandidate.id) : sourceLabel;
                if (!sourceCandidate) {
                  await handleDeadTargetNotApplied("source_missing", "canonical source issue is missing or outside this company", sourceIssueId, sourceCandidateLabel);
                  break;
                }
                if (sourceCandidate.missionId !== mission.id) {
                  await handleDeadTargetNotApplied("source_other_mission", "canonical source issue belongs to a different mission", sourceIssueId, sourceCandidateLabel);
                  break;
                }
                if (sourceCandidate.hiddenAt) {
                  await handleDeadTargetNotApplied("source_hidden", "canonical source issue is hidden", sourceIssueId, sourceCandidateLabel);
                  break;
                }
                if (isTerminalIssueStatus(sourceCandidate.status) && !isProducerRework) {
                  await handleDeadTargetNotApplied("source_terminal", `canonical source issue is already terminal status=${sourceCandidate.status}`, sourceIssueId, sourceCandidateLabel);
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
                if (autoDefaulted) {
                  const resolvedWait = await checkAutomaticOwnerRetryWait(db, {
                    companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                    ownerActionIssueId: issue.id, ownerActionStatus: issue.status,
                    originalSourceIssueId: issue.originId!, retryIssueId: sourceCandidate.id,
                  });
                  if (resolvedWait.kind !== "clear") {
                    findings.push(`owner_action_grace_default_waiting: ${label} exact human wait=${resolvedWait.kind}${resolvedWait.kind === "unresolved" ? ` reason=${resolvedWait.reasonCode}` : ` bindings=${resolvedWait.bindingIds.join(",")}`}`);
                    break;
                  }
                }
                const staleValidationGateRetry = await requeueStaleValidationGateBeforeOwnerRetry({ language: supervisionLanguage,
                  db,
                  mission,
                  ownerActionIssue: issue,
                  ownerActionLabel: label,
                  sourceIssue: sourceCandidate,
                  sourceLabel: sourceCandidateLabel,
                  sourceStepRows: stepRowsByIssueId.get(sourceCandidate.id) ?? [],
                  stepRows,
                  missionIssues,
                  now,
                  dispatchWakeup: Boolean(input.dispatchOwnerDecisionWakeups),
                  onWakeup: deps.onOwnerDecisionRetrySourceIssueApplied,
                });
                if (staleValidationGateRetry) {
                  findings.push(...staleValidationGateRetry.findings);
                  const appliedAction = staleValidationGateRetry.appliedAction;
                  if (appliedAction) {
                    appliedActions.push(appliedAction);
                  }
                  break;
                }
                const sourceRuns = heartbeatRunsByIssueId.get(sourceCandidate.id) ?? [];
                const sourceHasActiveHeartbeat = sourceRuns.some((run) => run.status === "queued" || run.status === "running");
                const sourceHasFailedRun = sourceRuns.some((run) => run.status === "failed" || run.status === "timed_out" || run.error || run.errorCode || (run.exitCode != null && run.exitCode !== 0));
                const sourceHasCompletedCorrectionEvidence = Boolean(
                  await loadActiveWorkProductUpdatedAt(db, mission.companyId, sourceCandidate.id),
                );
                const sourceComments = commentsByIssueId.get(sourceCandidate.id) ?? [];
                if (sourceHasActiveHeartbeat) break;
                const idempotencyKey = await resolveOwnerRetryKey({
                  db, companyId: mission.companyId, missionId: mission.id,
                  ownerActionIssueId: issue.id, sourceIssueId: sourceCandidate.id,
                  decision: autoDefaulted ? null : decisionRecord,
                });
                const retryApplyIdempotencyKey = `${idempotencyKey}:apply`;
                const [retryWakeupRecorded, retryApplyRecorded] = await Promise.all([
                  hasDispatchedRecoveryWakeup(db, mission.companyId, idempotencyKey),
                  hasRecoveryIdempotency(db, mission.companyId, retryApplyIdempotencyKey),
                ]);
                const sourceIsRetryableStaleQueue = (sourceCandidate.status === "todo" || sourceCandidate.status === "backlog")
                  && !sourceHasActiveHeartbeat
                  && (sourceHasFailedRun || sourceHasCompletedCorrectionEvidence || retryWakeupRecorded || retryApplyRecorded);
                if (!isProducerRework && sourceCandidate.status !== "blocked" && !sourceIsRetryableStaleQueue) {
                  findings.push(summarizeOwnerDecisionNotApplied({ ownerActionLabel: label, sourceLabel: sourceCandidateLabel, reason: `canonical source issue is status=${sourceCandidate.status}, not blocked, or not a stale queue with failure, correction, or prior retry evidence` }));
                  break;
                }
                const originComments = issue.originId && issue.originId !== sourceCandidate.id
                  ? commentsByIssueId.get(issue.originId) ?? []
                  : [];
                const requestChangesSummary = extractLatestRequestChangesSummary([
                  ...sourceComments,
                  ...originComments,
                  ...comments,
                  issue.description,
                ]);
                if (retryWakeupRecorded) {
                  const blockedOriginIssue = issue.originId && issue.originId !== sourceCandidate.id
                    ? missionIssueById.get(issue.originId) ?? null
                    : null;
                  const retryUnresolvedMarker = blockedOriginIssue
                    ? `mission-owner-retry-unresolved:${mission.id}:${issue.id}:${sourceCandidate.id}:${blockedOriginIssue.id}`
                    : null;
                  // [liveness] retry chain 이 per-issue live(queued/claimed/deferred_issue_execution/
                  //   coalesced wake 중 하나) 면 아직 진행 중이므로 "해결 못 함" 에스컬레이션 금지.
                  //   mission-global heartbeat-only 판정은 claimed/deferred/coalesced wake 를 놓친다.
                  const retryChainLiveWake = liveWakeupIssueIds.has(issue.id)
                    || liveWakeupIssueIds.has(sourceCandidate.id)
                    || (blockedOriginIssue ? liveWakeupIssueIds.has(blockedOriginIssue.id) : false);
                  const retryResolvedNothing = isProducerRework
                    && blockedOriginIssue?.status === "blocked"
                    && isTerminalIssueStatus(sourceCandidate.status)
                    && !missionHasActiveHeartbeat
                    && !retryChainLiveWake;
                  if (retryResolvedNothing && blockedOriginIssue && retryUnresolvedMarker) {
                    const [pendingWakeup] = await db
                      .select({ id: agentWakeupRequests.id })
                      .from(agentWakeupRequests)
                      .where(and(
                        eq(agentWakeupRequests.companyId, mission.companyId),
                        // [liveness] 전체 LIVE_WAKEUP_STATUSES 로 확대 — deferred_issue_execution/
                        //   coalesced 도 "대기 중" 으로 인정해 거짓 replan/escalate 방지.
                        inArray(agentWakeupRequests.status, [...LIVE_WAKEUP_STATUSES]),
                        or(
                          eq(agentWakeupRequests.missionId, mission.id),
                          eq(agentWakeupRequests.issueId, issue.id),
                          eq(agentWakeupRequests.issueId, sourceCandidate.id),
                          eq(agentWakeupRequests.issueId, blockedOriginIssue.id),
                        ),
                      ))
                      .limit(1);
                    if (pendingWakeup) {
                      findings.push(`owner_action_retry_unresolved_waiting: ${label} retry_source_issue source=${sourceCandidateLabel} already applied; ${blockedOriginIssue.identifier ?? blockedOriginIssue.id} remains blocked but wakeup=${pendingWakeup.id} is still queued/claimed`);
                      break;
                    }
                    if (await hasRecoveryIdempotency(db, mission.companyId, retryUnresolvedMarker)) {
                      findings.push(`owner_action_retry_unresolved_already_escalated: ${label} retry_source_issue source=${sourceCandidateLabel} terminal=${sourceCandidate.status}; ${blockedOriginIssue.identifier ?? blockedOriginIssue.id} remains blocked`);
                      break;
                    }
                    addRecommendation({
                      type: "request_replan",
                      missionId: mission.id,
                      issueId: blockedOriginIssue.id,
                      reason: `Retry target ${sourceCandidateLabel} reached terminal status=${sourceCandidate.status}, but blocked issue ${blockedOriginIssue.identifier ?? blockedOriginIssue.id} is still blocked; owner must choose a new recovery path instead of repeating the same retry`,
                      safeToAutoApply: false,
                    });
                    addRecommendation({
                      type: "escalate_blocked",
                      missionId: mission.id,
                      issueId: issue.id,
                      reason: `Owner action ${label} already applied retry_source_issue and it did not unblock ${blockedOriginIssue.identifier ?? blockedOriginIssue.id}`,
                      safeToAutoApply: false,
                    });
                    let ownerWakeupStatus: MissionOwnerDecisionWakeupDispatchStatus = "not_requested";
                    try {
                      ownerWakeupStatus = await ownerActions.reopenUnresolvedRetryOwnerAction({
                        mission,
                        ownerActionIssue: issue,
                        retryTargetIssue: sourceCandidate,
                        retryTargetLabel: sourceCandidateLabel,
                        blockedIssue: blockedOriginIssue,
                        marker: retryUnresolvedMarker,
                        dispatchWakeup: Boolean(input.dispatchOwnerDecisionWakeups),
                      });
                      if (ownerWakeupStatus === "failed") {
                        findings.push(`owner_action_retry_unresolved_wakeup_skipped: ${label} no owner action wakeup callback configured`);
                      }
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      findings.push(`owner_action_retry_unresolved_wakeup_failed: ${label} owner wakeup callback failed — ${message}`);
                      ownerWakeupStatus = "failed";
                    }
                    await recordRecoveryAction({
                      db,
                      companyId: mission.companyId,
                      missionId: mission.id,
                      issueId: issue.id,
                      sourceIssueId: sourceCandidate.id,
                      idempotencyKey: retryUnresolvedMarker,
                      eventType: "mission_owner_retry_unresolved",
                      decision: "retry_source_issue",
                      resultStatus: ownerWakeupStatus,
                    });
                    findings.push(`owner_action_retry_unresolved_escalated: ${label} retry_source_issue source=${sourceCandidateLabel} terminal=${sourceCandidate.status}; ${blockedOriginIssue.identifier ?? blockedOriginIssue.id} remains blocked; canonical owner anchor ensured`);
                    appliedActions.push({
                      type: "owner_decision_retry_unresolved",
                      missionId: mission.id,
                      ownerActionIssueId: issue.id,
                      sourceIssueId: sourceCandidate.id,
                      blockedIssueId: blockedOriginIssue.id,
                      resultStatus: "todo",
                      wakeupDispatchStatus: ownerWakeupStatus,
                    });
                    break;
                  }
                  if (input.dispatchOwnerDecisionWakeups && !retryWakeupRecorded) {
                    let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = "skipped_no_assignee";
                    if (!sourceCandidate.assigneeAgentId) {
                      findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} source issue has no assignee; wakeup dispatch skipped`);
                    } else if (deps.onOwnerDecisionRetrySourceIssueApplied) {
                      try {
                        if (requestChangesSummary && !sourceComments.some((comment) => comment.includes("Latest REQUEST_CHANGES summary:") && comment.includes(requestChangesSummary))) {
                          await issueService(db).addComment(sourceCandidate.id, buildRetrySourceIssueRequestChangesContextComment({ language: supervisionLanguage,
                            ownerActionIssueId: issue.id,
                            ownerActionLabel: label,
                            sourceIssueId: sourceCandidate.id,
                            sourceLabel: sourceCandidateLabel,
                            requestChangesSummary,
                          }), { agentId: mission.ownerAgentId });
                        }
                        const wakeupResult = await deps.onOwnerDecisionRetrySourceIssueApplied({
                          mission,
                          ownerActionIssue: issue,
                          sourceIssue: sourceCandidate,
                          targetAgentId: sourceCandidate.assigneeAgentId,
                          idempotencyKey,
                          decisionCommentId: autoDefaulted ? null : decisionRecord!.eventId,
                        });
                        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
                        await issueService(db).addComment(
                          sourceCandidate.id,
                          buildRetrySourceIssueWakeupResultComment({ language: supervisionLanguage,
                            status: wakeupDispatchStatus,
                            missionId: mission.id,
                            ownerActionIssueId: issue.id,
                            ownerActionLabel: label,
                            sourceIssueId: sourceCandidate.id,
                            sourceLabel: sourceCandidateLabel,
                            targetAgentId: sourceCandidate.assigneeAgentId,
                            idempotencyKey,
                            detailReason: readWakeupResultDetailReason(wakeupResult),
                          }),
                          { agentId: mission.ownerAgentId },
                        );
                        await recordRecoveryAction({
                          db,
                          companyId: mission.companyId,
                          missionId: mission.id,
                          issueId: issue.id,
                          sourceIssueId: sourceCandidate.id,
                          idempotencyKey,
                          eventType: "mission_owner_retry_wakeup",
                          decision: "retry_source_issue",
                          resultStatus: wakeupDispatchStatus,
                        });
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
                      resultStatus: sourceCandidate.status,
                      wakeupDispatchStatus,
                      idempotencyKey,
                    });
                  } else {
                    findings.push(`owner_action_decision_already_applied: ${label} retry_source_issue source=${sourceCandidateLabel}`);
                  }
                  break;
                }
                if (retryApplyRecorded) {
                  // [half-applied owner decision] apply 는 됐으나 wakeup 이 발사된 적 없다(not_requested/failed/skipped
                  //   마커만 존재). 교리(owner-decision-apply-dispatch-wiring): 결정을 재적용(reopen/재코멘트)하지 말고
                  //   빠진 발사만 보낸다. 발사가 계속 불가능하면 replan 권고로 가시화한다(무한 stall 방지).
                  if (!sourceCandidate.assigneeAgentId) {
                    findings.push(`owner_action_retry_wakeup_stalled: ${label} retry_source_issue source=${sourceCandidateLabel} apply recorded but source has no assignee; wakeup cannot be dispatched`);
                    addRecommendation({
                      type: "request_replan",
                      missionId: mission.id,
                      issueId: sourceCandidate.id,
                      reason: `owner retry already applied but wakeup undispatchable (${sourceCandidateLabel} has no assignee); reassign or replan`,
                      safeToAutoApply: false,
                    });
                    // [dispatch-stall escalation] 결정은 기록됐으나 파견 불능이 지속되면 오너를 1회 재깨운다(멱등 마커).
                    if (deps.onOwnerDecisionDispatchStalledWakeRequested) {
                      const stalledKey = `mission-owner-decision-stalled-wake:${mission.id}:${issue.id}`;
                      const claimed = await claimSupervisionMarkerOnce({
                        db, companyId: mission.companyId, missionId: mission.id, issueId: issue.id,
                        idempotencyKey: stalledKey, eventType: "mission_owner_decision_stalled_wake",
                        payload: { sourceIssueId: sourceCandidate.id, dispatchStatus: "no_assignee" },
                      });
                      if (claimed) {
                        try {
                          await deps.onOwnerDecisionDispatchStalledWakeRequested({
                            mission, ownerActionIssue: issue, sourceIssue: sourceCandidate,
                            dispatchStatus: "no_assignee", idempotencyKey: stalledKey,
                          });
                          findings.push(`owner_decision_dispatch_stalled_wake_requested: ${label} source=${sourceCandidateLabel} dispatch=no_assignee — owner re-woken once to fix the undispatchable retry`);
                        } catch (err) {
                          logger.warn({ err, missionId: mission.id, issueId: issue.id }, "owner decision stalled wake callback failed");
                        }
                      }
                    }
                  } else if (input.dispatchOwnerDecisionWakeups && deps.onOwnerDecisionRetrySourceIssueApplied) {
                    try {
                      const wakeupResult = await deps.onOwnerDecisionRetrySourceIssueApplied({
                        mission,
                        ownerActionIssue: issue,
                        sourceIssue: sourceCandidate,
                        targetAgentId: sourceCandidate.assigneeAgentId,
                        idempotencyKey,
                        decisionCommentId: autoDefaulted ? null : decisionRecord!.eventId,
                      });
                      const redispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
                      await recordRecoveryAction({
                        db,
                        companyId: mission.companyId,
                        missionId: mission.id,
                        issueId: issue.id,
                        sourceIssueId: sourceCandidate.id,
                        idempotencyKey,
                        eventType: "mission_owner_retry_wakeup",
                        decision: "retry_source_issue",
                        resultStatus: redispatchStatus,
                      });
                      appliedActions.push({
                        type: "owner_decision_retry_source_issue",
                        missionId: mission.id,
                        ownerActionIssueId: issue.id,
                        sourceIssueId: sourceCandidate.id,
                        resultStatus: sourceCandidate.status,
                        wakeupDispatchStatus: redispatchStatus,
                        idempotencyKey,
                      });
                      if (DISPATCHED_RECOVERY_WAKEUP_STATUSES.has(redispatchStatus)) {
                        await issueService(db).addComment(
                          sourceCandidate.id,
                          buildRetrySourceIssueWakeupResultComment({ language: supervisionLanguage,
                            status: redispatchStatus,
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
                        const redispatchValidatorEvidence = ownerActions.buildCorrectedArtifactValidatorRetryEvidence({
                          sourceIssue: sourceCandidate,
                          sourceLabel: sourceCandidateLabel,
                          missionIssues,
                          commentsByIssueId,
                        });
                        if (redispatchValidatorEvidence) {
                          await issueService(db).addComment(
                            sourceCandidate.id,
                            redispatchValidatorEvidence.comment,
                            { agentId: mission.ownerAgentId },
                          );
                        }
                        findings.push(`owner_action_retry_wakeup_redispatched: ${label} retry_source_issue source=${sourceCandidateLabel} — half-applied retry recovered, wakeup ${redispatchStatus}`);
                      } else {
                        findings.push(`owner_action_retry_wakeup_stalled: ${label} retry_source_issue source=${sourceCandidateLabel} apply recorded but dispatch result=${redispatchStatus}; native resume could not dispatch — replan or operator action required`);
                        addRecommendation({
                          type: "request_replan",
                          missionId: mission.id,
                          issueId: sourceCandidate.id,
                          reason: `owner retry already applied but wakeup dispatch returned ${redispatchStatus}; native resume link missing — replan or operator action required`,
                          safeToAutoApply: false,
                        });
                        // [dispatch-stall escalation] 재발사가 계속 실패하면 오너를 1회 재깨운다(멱등 마커).
                        if (deps.onOwnerDecisionDispatchStalledWakeRequested) {
                          const stalledKey = `mission-owner-decision-stalled-wake:${mission.id}:${issue.id}`;
                          const claimed = await claimSupervisionMarkerOnce({
                            db, companyId: mission.companyId, missionId: mission.id, issueId: issue.id,
                            idempotencyKey: stalledKey, eventType: "mission_owner_decision_stalled_wake",
                            payload: { sourceIssueId: sourceCandidate.id, dispatchStatus: redispatchStatus },
                          });
                          if (claimed) {
                            try {
                              await deps.onOwnerDecisionDispatchStalledWakeRequested({
                                mission, ownerActionIssue: issue, sourceIssue: sourceCandidate,
                                dispatchStatus: redispatchStatus, idempotencyKey: stalledKey,
                              });
                              findings.push(`owner_decision_dispatch_stalled_wake_requested: ${label} source=${sourceCandidateLabel} dispatch=${redispatchStatus} — owner re-woken once to fix the undispatchable retry`);
                            } catch (err) {
                              logger.warn({ err, missionId: mission.id, issueId: issue.id }, "owner decision stalled wake callback failed");
                            }
                          }
                        }
                      }
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      findings.push(`owner_action_retry_wakeup_failed: ${sourceCandidateLabel} half-applied retry wakeup callback failed — ${message}`);
                    }
                  } else {
                    findings.push(`owner_action_retry_wakeup_pending_dispatch: ${label} retry_source_issue source=${sourceCandidateLabel} apply recorded but wakeup not dispatched yet (dispatch flags or callback unavailable this sweep)`);
                  }
                  break;
                }
                let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchOwnerDecisionWakeups ? "skipped_no_assignee" : "not_requested";
                // [P3 producer rework authorization] upstream producer rework(isProducerRework ∧ source≠origin)
                //   만 authorize 적용. 일반 source self-retry(sourceCandidate===origin)는 기존 reopen 계약 유지(codex 정정 2).
                let reopenStatuses = isProducerRework ? ["blocked", "todo", "backlog", "done"] : ["blocked", "todo", "backlog"], authQaGateId: string | null = null;
                if (isProducerRework && sourceCandidate.id !== issue.originId) {
                  // 명시 reworkTarget 또는 current-gen REQUEST_CHANGES 만 producer reopen 허용(req 3, codex 계약 3).
                  // DAG-guess/guardrail/stale/unverified = deny+replan.
                  // [cap-oversight QA authority] origin 이 oversight 라 resolveQaGateIssueId 가 null 인
                  //   qa-cap 이슈는 설명의 QA step id 로 stepRows 를 직접 찾아 QA 게이트 이슈를 구한다.
                  authQaGateId = resolveQaGateIssueId({ originId: issue.originId, missionIssueById, stepRowsByIssueId });
                  if (!authQaGateId && isQaReworkCapOversightIssue(issue.description)) {
                    const capQaStepId = extractQaCapQaStepId(issue.description);
                    if (capQaStepId) {
                      const qaStepRow = stepRows.find((row) => row.stepRun.stepId === capQaStepId && row.stepRun.issueId) ?? null;
                      authQaGateId = qaStepRow?.stepRun.issueId ?? null;
                    }
                  }
                  const validationVerdictsByIssueId = await loadQaGateVerdictMap(db, mission.companyId, authQaGateId);
                  const failureReasonCode = await loadLatestFailureReasonCode(db, mission.companyId, sourceCandidate.id);
                  const artifactUpdatedAt = await loadActiveWorkProductUpdatedAt(db, mission.companyId, sourceCandidate.id);
                  const reworkAuth = authorizeProducerRework({
                    ownerReworkRef: ownerDecision.recoveryTarget?.kind === "issue" ? ownerDecision.recoveryTarget.issueId : ownerReworkRef,
                    failureReasonCode,
                    qaIssueId: authQaGateId,
                    validationVerdictsByIssueId,
                    producerCompletedAt: artifactUpdatedAt ?? sourceCandidate.completedAt,
                  });
                  if (!reworkAuth.authorized) {
                    findings.push(`producer_rework_unauthorized: ${label} source=${sourceCandidateLabel} reason=${reworkAuth.reason} — request_replan instead of producer reopen`);
                    addRecommendation({ type: "request_replan", missionId: mission.id, issueId: sourceCandidate.id, reason: `producer rework unauthorized (${reworkAuth.reason}); no DAG-guess/guardrail/stale reopen`, safeToAutoApply: false });
                    break;
                  }
                  const allowDoneReopen = reworkAuth.reason === "explicit_rework_target" || reworkAuth.reason === "fresh_request_changes_verdict";
                  reopenStatuses = allowDoneReopen ? ["blocked", "todo", "backlog", "done"] : ["blocked", "todo", "backlog"];
                }
                // cap-override owns its atomic reopen/rollback; supervision must not reopen first.
                const capOverrideCandidate = isProducerRework
                  && await isCapOverrideRetryCandidate(db, mission.companyId, sourceCandidate.id);
                const willDispatchWakeup = input.dispatchOwnerDecisionWakeups
                  && !!sourceCandidate.assigneeAgentId
                  && !!deps.onOwnerDecisionRetrySourceIssueApplied;
                const sourceIsWorkflowBacked = (stepRowsByIssueId.get(sourceCandidate.id)?.length ?? 0) > 0;
                let shouldReopenToTodo = !capOverrideCandidate
                  && (isProducerRework || (willDispatchWakeup && sourceIsWorkflowBacked));
                if (autoDefaulted) {
                  const applied = await applyAutomaticOwnerRetryIfClear({
                    db, companyId: mission.companyId, missionId: mission.id, ownerAgentId: mission.ownerAgentId,
                    ownerActionIssueId: issue.id, ownerActionStatus: issue.status,
                    originalSourceIssueId: issue.originId!, retryIssueId: sourceCandidate.id, retryTargetId: sourceCandidate.id,
                    retryKey: idempotencyKey, applyKey: retryApplyIdempotencyKey, now, graceMs: 20 * 60 * 1000,
                    dispatchRequested: Boolean(input.dispatchOwnerDecisionWakeups),
                    callbackAvailable: Boolean(deps.onOwnerDecisionRetrySourceIssueApplied),
                    producerRework: isProducerRework,
                    producer: automaticProducerIdentity ? { ...automaticProducerIdentity, qaGateIssueId: authQaGateId,
                      missionHasNativeLoop } : null,
                  });
                  if (applied.kind !== "applied") {
                    findings.push(`owner_action_grace_default_not_applied: ${label} source=${sourceCandidateLabel} reason=${applied.reason}`);
                    break;
                  }
                  sourceCandidate = applied.sourceIssue;
                  sourceCandidateLabel = sourceCandidate.identifier ?? sourceCandidate.id;
                  shouldReopenToTodo = applied.reopened;
                } else if (shouldReopenToTodo) {
                  await db
                    .update(issues)
                    .set({ status: "todo", updatedAt: now, completedAt: null })
                    .where(and(eq(issues.id, sourceCandidate.id), eq(issues.companyId, mission.companyId), inArray(issues.status, reopenStatuses), isNull(issues.hiddenAt)));
                }
                const activeSourceWorkProducts = await loadActiveSourceIssueWorkProducts(db, mission.companyId, mission.id, sourceCandidate.id);
                await issueService(db).addComment(
                  sourceCandidate.id,
                  buildRetrySourceIssueComment({
                    ownerActionIssueId: issue.id,
                    ownerActionLabel: label,
                    sourceIssueId: sourceCandidate.id,
                    sourceLabel: sourceCandidateLabel,
                    decisionReason: ownerDecision.reason,
                    requestChangesSummary,
                    sourceInstruction: sourceCandidate.description,
                    sourceTitle: sourceCandidate.title,
                    activeWorkProducts: activeSourceWorkProducts,
                    language: supervisionLanguage,
                  }),
                  { agentId: mission.ownerAgentId },
                );
                if (!autoDefaulted) await recordRecoveryAction({
                  db, companyId: mission.companyId, missionId: mission.id, issueId: issue.id,
                  sourceIssueId: sourceCandidate.id, idempotencyKey: retryApplyIdempotencyKey,
                  eventType: "mission_owner_retry_apply", decision: "retry_source_issue",
                  resultStatus: shouldReopenToTodo ? "todo" : sourceCandidate.status,
                });
                if (input.dispatchOwnerDecisionWakeups) {
                  if (!sourceCandidate.assigneeAgentId) {
                    findings.push(`owner_action_wakeup_skipped: ${sourceCandidateLabel} source issue has no assignee; wakeup dispatch skipped`);
                    wakeupDispatchStatus = "skipped_no_assignee";
                  } else if (deps.onOwnerDecisionRetrySourceIssueApplied) {
                    try {
                      const wakeupResult = await deps.onOwnerDecisionRetrySourceIssueApplied({
                        mission,
                        ownerActionIssue: issue,
                        sourceIssue: sourceCandidate,
                        targetAgentId: sourceCandidate.assigneeAgentId,
                        idempotencyKey,
                        decisionCommentId: autoDefaulted ? null : decisionRecord!.eventId,
                      });
                      wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
                      await issueService(db).addComment(
                        sourceCandidate.id,
                        buildRetrySourceIssueWakeupResultComment({ language: supervisionLanguage,
                          status: wakeupDispatchStatus,
                          missionId: mission.id,
                          ownerActionIssueId: issue.id,
                          ownerActionLabel: label,
                          sourceIssueId: sourceCandidate.id,
                          sourceLabel: sourceCandidateLabel,
                          targetAgentId: sourceCandidate.assigneeAgentId,
                          idempotencyKey,
                          detailReason: readWakeupResultDetailReason(wakeupResult),
                        }),
                        { agentId: mission.ownerAgentId },
                      );
                      const validatorEvidence = ownerActions.buildCorrectedArtifactValidatorRetryEvidence({
                        sourceIssue: sourceCandidate,
                        sourceLabel: sourceCandidateLabel,
                        missionIssues,
                        commentsByIssueId,
                      });
                      if (validatorEvidence) {
                        await issueService(db).addComment(
                          sourceCandidate.id,
                          validatorEvidence.comment,
                          { agentId: mission.ownerAgentId },
                        );
                      }
                      await recordRecoveryAction({
                        db,
                        companyId: mission.companyId,
                        missionId: mission.id,
                        issueId: issue.id,
                        sourceIssueId: sourceCandidate.id,
                        idempotencyKey,
                        eventType: "mission_owner_retry_wakeup",
                        decision: "retry_source_issue",
                        resultStatus: wakeupDispatchStatus,
                      });
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
                  resultStatus: shouldReopenToTodo ? "todo" : sourceCandidate.status,
                  wakeupDispatchStatus,
                  idempotencyKey,
                });
                } finally { await releaseRetryLock(); }
              }
              break;
            case "reassign_source_issue":
              addRecommendation({
                type: "request_approval",
                missionId: mission.id,
                issueId: sourceIssue?.id ?? issue.originId ?? issue.id,
                reason: `${baseReason}; source issue reassignment can be applied when a target assignee is explicit and runnable`,
                safeToAutoApply: true,
              });
              if (input.applyOwnerDecisionActions) {
                const sourceRuns = sourceIssue ? (heartbeatRunsByIssueId.get(sourceIssue.id) ?? []) : [];
                const sourcePlanGateReason = sourceIssue
                  ? activePlanRecoveryGateReason(activePlan, sourceIssue, stepRowsByIssueId.get(sourceIssue.id) ?? [])
                  : null;
                const result = await applyReassignSourceIssueDecision({ language: supervisionLanguage,
                  db,
                  mission,
                  ownerActionIssue: issue,
                  ownerActionLabel: label,
                  ownerDecision: {
                    decision: "reassign_source_issue",
                    reason: ownerDecision.reason,
                    nextAction: ownerDecision.nextAction,
                    evidence: ownerDecision.evidence,
                  },
                  sourceIssue,
                  sourceLabel,
                  sourceComments: sourceIssue ? (commentsByIssueId.get(sourceIssue.id) ?? []) : [],
                  sourceHasActiveHeartbeat: sourceRuns.some((run) => run.status === "queued" || run.status === "running"),
                  sourcePlanGateReason,
                  now,
                  dispatchWakeup: Boolean(input.dispatchOwnerDecisionWakeups),
                  onWakeup: deps.onOwnerDecisionRetrySourceIssueApplied,
                });
                findings.push(...result.findings);
                if (result.appliedAction) appliedActions.push(result.appliedAction);
              }
              break;
            case "replan_mission":
              addRecommendation({
                type: "request_replan",
                missionId: mission.id,
                issueId: issue.id,
                reason: `${baseReason}; mission plan revision is required before execution changes`,
                safeToAutoApply: false,
              });
              if (input.applyOwnerDecisionActions) {
                const replan = await applyOwnerReplanDecision({
                  db,
                  mission,
                  ownerActionIssueId: issue.id,
                  expectedDecisionEventId: decisionRecord!.eventId,
                });
                if (!replan) break;
                if (replan.planningIssue.assigneeAgentId && deps.onOwnerPlanningIssueCreated) {
                  try {
                    await deps.onOwnerPlanningIssueCreated({
                      mission,
                      issue: replan.planningIssue,
                      targetAgentId: replan.planningIssue.assigneeAgentId,
                      idempotencyKey: `mission-owner-replan-wakeup:${mission.id}:${replan.planningIssue.id}`,
                    });
                  } catch (err) {
                    logger.warn({ err, missionId: mission.id, issueId: replan.planningIssue.id }, "failed to notify owner about mission replan issue");
                  }
                }
                appliedActions.push({
                  type: "owner_decision_replan_mission",
                  missionId: mission.id,
                  ownerActionIssueId: issue.id,
                  planningIssueId: replan.planningIssue.id,
                  resultStatus: replan.planningIssue.status,
                });
              }
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
        findings.push(`owner_unblock_action_blocked: ${label} is a mission owner unblock action for ${sourceLabel} but is itself blocked — ${issue.title}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          issueId: issue.id,
          reason: `Owner unblock action ${label} is self-blocked; owner should choose a recovery decision instead of blocking the recovery issue`,
          safeToAutoApply: false,
        });
        // [terminal-mission Human Operator report — review correction] recovery issue 자체가 terminal
        //   failed/timed_out run 으로 blocked 되었을 때, mission 전체의 권위 continuation 신호를 평가해
        //   "정말 종단"이면 structured owner-decision comment + recordHumanOperatorRequestEvent channel 로
        //   terminal evidence snapshot 마다 정확히 한 번 보고한다. atomic claim(workflowTransitionEvents
        //   unique index)으로 concurrency/retry-safe. system-authored(owner 귀속 ❌). 모든 continuation guard
        //   (heartbeat/wakeup/process-loss/fallback/tool-recovery/source-resume/runnable failure|always|IF branch)
        //   중 하나라도 남거나 불확실하면 suppress(fail-closed).
        const issueTerminalFailedRuns = runsForIssue
          .filter((run) => TERMINAL_FAILURE_RUN_STATUSES.has(run.status))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const reportGroup = terminalReportGroupByTriggerIssueId.get(issue.id);
        if (issueTerminalFailedRuns.length > 0 && reportGroup && canonicalTerminalOwnerAction) {
          await tryEmitTerminalReport({
            ownerAction: canonicalTerminalOwnerAction,
            group: reportGroup,
            label: `${label} terminal run=${issueTerminalFailedRuns[0]!.id}`,
          });
        }
      }
      if (
        issue.status === "blocked" && !issue.hiddenAt && !isTerminalMissionStatus(mission.status) &&
        issue.originKind !== "mission_main_executor_unblock" &&
        !isRejectedPlanningIssue &&
        !qaCapSourceIssueIds.has(issue.id)
      ) {
        await ownerActions.ensureMainExecutorUnblockIssue(mission, issue);
        // Structured authority only: durable gate activity + recovery ledger. Comment keywords
        // (artifact missing / replan / escalate prose) are display-only and never suppress or
        // authorize recommendations.
        const recurringIssues = await ownerActions.listRecurringArtifactMissingIssueRefs({
          companyId: mission.companyId,
          assigneeAgentId: issue.assigneeAgentId,
          since: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
        });
        if (recurringIssues.some((row) => row.id === issue.id) && recurringIssues.length >= 2) {
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
        const hasStructuredRecovery = await hasStructuredSourceRecoveryDecision({
          db,
          companyId: mission.companyId,
          sourceIssueId: issue.id,
        });
        if (!hasStructuredRecovery) {
          findings.push(`blocked_without_replan: ${label} blocked without structured recovery decision — ${issue.title}`);
          addRecommendation({ type: "request_replan", missionId: mission.id, issueId: issue.id, reason: `Blocked issue ${label} needs recovery/replan evidence`, safeToAutoApply: false });
          addRecommendation({ type: "escalate_blocked", missionId: mission.id, issueId: issue.id, reason: `Blocked issue ${label} needs owner escalation or impossible-completion report`, safeToAutoApply: false });
        }
        if (!missionHasActiveHeartbeat) {
          await tryDispatchWorkProductReuseWake({ sourceIssue: issue, sourceLabel: label });
        }
      }
    }

    // [2b 분해] workflow 복구 리포트 → 안전 액션 적용 → 최종 코멘트 발행은
    //   supervision-post-loop-phases.ts 의 runMissionPostLoopPhases 로 옮겼다(본문 이동만, 동작 동일).
    return runMissionPostLoopPhases({
      db,
      deps,
      ownerActions,
      input,
      context,
      governanceEvidenceLines,
      oversightIssue,
      now,
      staleAfterMs,
      findings,
      recommendations,
      addRecommendation,
      appliedActions,
      recoveryOutcomes,
      canonicalTerminalOwnerAction,
      terminalReportGroups,
      tryEmitTerminalReport,
      qaCapOwnerActionByWorkflowRunId,
      qaCapPendingWorkflowRunIds,
      planSubmissionMissingCandidate,
    });
  }

  return runMainExecutorSupervision;
}
