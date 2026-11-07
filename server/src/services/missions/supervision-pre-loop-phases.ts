// server/src/services/missions/supervision-pre-loop-phases.ts
//
// [수정시 주의] main executor supervision 의 per-issue 루프 **이전** 단계 묶음.
// supervision-main.ts 의 runMainExecutorSupervision 안에 있던 구간(원본 231-816)을 본문 변경 없이 옮긴 모듈이다.
// 이 모듈이 만드는 것: (1) terminal report 그룹과 발행 클로저(tryEmitTerminalReport), (2) QA rework cap 소진
// 판정과 [QA Cap] 액션 버킷, (3) plan decision 상태 판정(planSubmissionMissingCandidate), (4) work-product
// reuse wake 디스패처(tryDispatchWorkProductReuseWake). 뒤 단계(per-issue 루프·workflow 복구·정리)가 쓰는
// 값·클로저는 반환한다.
// 원본은 바깥 함수 클로저로 값을 잡았으므로, 여기서는 입력을 MissionPreLoopPhaseInputs 하나로 받는다.
// 반환 객체의 필드가 바뀌면 supervision-main.ts 의 구조 분해도 함께 고쳐야 한다(타입 검사가 잡는다).
import { agentWakeupRequests, missionPlanDecisionSubmissions, missions, workflowRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { workProductService } from "../work-products.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { findLatestAuthorizedMissionOwnerPlanDecision } from "../mission-owner-plan-decisions.js";
import type { createOwnerActions } from "./owner-actions.js";
import type { MissionServiceDeps } from "../missions.js";
import { buildWorkProductReuseWakeIdempotencyKey } from "./mission-owner-recovery-events.js";
import { buildWorkProductReuseWakeDispatchedComment } from "./mission-owner-recovery-comments.js";
import { listCompanyExecutionCandidates, formatCandidateRosterLines, candidateRosterFingerprint, type MissionExecutionCandidate } from "./mission-execution-candidates.js";
import { asRecord, isQaLikeStep, trimmedString, type DagStepLike } from "./supervision-helpers.js";
import { buildMissionSupervisionContext, type MissionSupervisionHeartbeatRun, type MissionSupervisionIssue, type MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import { formatMissionPlanDecisionSubmissionDiagnostics, isRejectedMissionPlanDecisionSubmissionStatus } from "./mission-plan-decision-ledger.js";
import { isQaRecoveryLive, resolveRecoveryOwnership } from "./recovery-ownership-guard.js";
import { detectQaReworkCapExhaustion, ensureQaReworkCapOversightIssue, isQaReworkCapOversightIssue } from "./qa-rework-cap-oversight.js";
import { loadConsecutiveQaRejectTrend } from "./qa-rework-cap-oversight-detection.js";
import { loadWorkflowApiFindings } from "../workflow/validation-verdict-ledger.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";
import { ensureQaSourceDefectOwnerCard } from "../workflow/qa-source-defect-owner-card.js";
import {
  TERMINAL_FAILURE_RUN_STATUSES,
  classifyTerminalMissionContinuation,
  emitTerminalMissionHumanOperatorReport,
  summarizeWorkflowRetryExhaustion,
} from "./terminal-mission-human-operator-alert.js";
import { loadTerminalValidationVerdicts } from "./terminal-mission-workflow-continuation.js";
import { summarizeProvider403LadderForMission } from "../heartbeat-provider403-ladder.js";
import { qualityService } from "../quality.js";
import { loadCompanySystemLanguage } from "./system-language.js";
import type { MissionOwnerSupervisionAppliedAction, MissionOwnerSupervisionRecommendation } from "./supervision-types.js";
import {
  hasRecentHumanEscalationDecision,
  hasRecoveryIdempotency,
  isPlanSubmissionRecoveryIssueStatus,
  recordRecoveryAction,
  REJECTED_PLAN_RECOVERY_PROMPT_REVISION,
} from "./supervision-support.js";

type MissionRow = typeof missions.$inferSelect;
type TerminalReportGroup = {
  triggerIssueId: string;
  workflowRunId: string | null;
  failedRuns: Array<{ id: string; status: string; errorCode: string | null }>;
  sourceIssue: MissionSupervisionIssue | null;
  workflowStepRows: MissionSupervisionWorkflowStepRow[];
};
type PlanSubmissionMissingCandidate = {
  kind: "missing";
  planIssue: MissionSupervisionIssue;
  succeededRun: MissionSupervisionHeartbeatRun;
  markerText: string;
  idempotencyKey: string;
} | {
  kind: "rejected";
  planIssue: MissionSupervisionIssue;
  succeededRun: MissionSupervisionHeartbeatRun | null;
  decisionHash: string;
  rejectionReason: string | null;
  diagnostics: unknown;
  previousDecision: unknown;
  candidateRoster: MissionExecutionCandidate[];
  markerText: string;
  idempotencyKey: string;
  candidateRosterLines: string[];
  retryAllowed: boolean;
};

/** 이 단계가 바깥에서 받는 입력. 원본 runMainExecutorSupervision 의 클로저 값과 팩토리 파라미터를 그대로 옮겼다. */
export interface MissionPreLoopPhaseInputs {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
  qSvc: ReturnType<typeof qualityService>;
  /** 이 구간은 input.applySafeActions 하나만 읽는다(나머지 input.* 는 이 모듈 안 중첩 클로저의 자체 파라미터). */
  input: { applySafeActions?: boolean };
  context: Awaited<ReturnType<typeof buildMissionSupervisionContext>>;
  missionScope: MissionRow | null;
  promotedFromPlanning: boolean;
  supervisionLanguage: Awaited<ReturnType<typeof loadCompanySystemLanguage>>;
  oversightIssue: MissionSupervisionIssue;
  findings: string[];
  addRecommendation: (recommendation: MissionOwnerSupervisionRecommendation) => void;
  appliedActions: MissionOwnerSupervisionAppliedAction[];
  missionHasActiveHeartbeat: boolean;
}

/** 뒤 단계가 이어서 쓰는 값·클로저. */
export interface MissionPreLoopPhaseResult {
  canonicalTerminalOwnerAction: MissionSupervisionIssue | null;
  terminalReportGroups: Map<string, TerminalReportGroup>;
  terminalReportGroupByTriggerIssueId: Map<string, TerminalReportGroup>;
  tryEmitTerminalReport: (input: {
    ownerAction: MissionSupervisionIssue | null;
    ensureOwnerAction?: () => Promise<MissionSupervisionIssue>;
    group: {
      workflowRunId: string | null;
      failedRuns: Array<{ id: string; status: string; errorCode: string | null }>;
      sourceIssue: MissionSupervisionIssue | null;
      workflowStepRows: MissionSupervisionWorkflowStepRow[];
    };
    label: string;
  }) => Promise<void>;
  qaCapOwnerActionByWorkflowRunId: Map<string, MissionSupervisionIssue>;
  qaCapPendingWorkflowRunIds: Set<string>;
  qaCapSourceIssueIds: Set<string>;
  rejectedPlanningIssueId: string | null;
  planSubmissionMissingCandidate: PlanSubmissionMissingCandidate | null;
  tryDispatchWorkProductReuseWake: (input: {
    sourceIssue: MissionSupervisionIssue;
    sourceLabel: string;
  }) => Promise<void>;
}

export async function runMissionPreLoopPhases({
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
}: MissionPreLoopPhaseInputs): Promise<MissionPreLoopPhaseResult> {
  const {
    mission,
    missionIssues,
    missionIssueById,
    heartbeatRunsByIssueId,
    stepRows,
    stepRowsByIssueId,
    activePlan,
  } = context;

    const terminalOwnerActions = missionIssues
      .filter((issue) => issue.status === "blocked" && issue.originKind === "mission_main_executor_unblock")
      .map((issue) => {
        const failedRuns = (heartbeatRunsByIssueId.get(issue.id) ?? [])
          .filter((run) => TERMINAL_FAILURE_RUN_STATUSES.has(run.status))
          .map((run) => ({ id: run.id, status: run.status, errorCode: run.errorCode ?? null }));
        const runIds = new Set(
          issue.originId
            ? (stepRowsByIssueId.get(issue.originId) ?? []).map((row) => row.run.id)
            : [],
        );
        return {
          issue,
          failedRuns,
          workflowRunId: runIds.size === 1 ? [...runIds][0]! : null,
        };
      })
      .filter((entry) => entry.failedRuns.length > 0)
      .sort((left, right) => left.issue.id.localeCompare(right.issue.id));

    const canonicalTerminalOwnerAction = missionIssues
      .filter((issue) => issue.originKind === "mission_main_executor_unblock" && !issue.hiddenAt && issue.status === "blocked")
      .sort((left, right) => {
        const qaPreference = Number(isQaReworkCapOversightIssue(right.description))
          - Number(isQaReworkCapOversightIssue(left.description));
        return qaPreference || left.id.localeCompare(right.id);
      })[0] ?? null;

    const terminalReportGroups = new Map<string, {
      triggerIssueId: string;
      workflowRunId: string | null;
      failedRuns: Array<{ id: string; status: string; errorCode: string | null }>;
      sourceIssue: MissionSupervisionIssue | null;
      workflowStepRows: MissionSupervisionWorkflowStepRow[];
    }>();
    for (const entry of terminalOwnerActions) {
      const scopeKey = entry.workflowRunId ?? "mission";
      const existing = terminalReportGroups.get(scopeKey);
      if (existing) {
        existing.failedRuns.push(...entry.failedRuns);
        continue;
      }
      terminalReportGroups.set(scopeKey, {
        triggerIssueId: entry.issue.id,
        workflowRunId: entry.workflowRunId,
        failedRuns: [...entry.failedRuns],
        sourceIssue: entry.issue.originId ? missionIssueById.get(entry.issue.originId) ?? null : null,
        workflowStepRows: entry.workflowRunId
          ? stepRows.filter((row) => row.run.id === entry.workflowRunId)
          : stepRows,
      });
    }
    const terminalReportGroupByTriggerIssueId = new Map(
      [...terminalReportGroups.values()].map((group) => [group.triggerIssueId, group]),
    );
    const tryEmitTerminalReport = async (input: {
      ownerAction: MissionSupervisionIssue | null;
      ensureOwnerAction?: () => Promise<MissionSupervisionIssue>;
      group: {
        workflowRunId: string | null;
        failedRuns: Array<{ id: string; status: string; errorCode: string | null }>;
        sourceIssue: MissionSupervisionIssue | null;
        workflowStepRows: MissionSupervisionWorkflowStepRow[];
      };
      label: string;
    }): Promise<void> => {
      const openOwnerActionRecoveryExists = missionIssues.some((missionIssue) => (
        missionIssue.id !== input.ownerAction?.id
        && missionIssue.originKind === "mission_main_executor_unblock"
        && (missionIssue.status === "todo" || missionIssue.status === "in_progress")
      ));
      const stepRunIssueIds = input.group.workflowStepRows
        .map((row) => row.stepRun.issueId)
        .filter((issueId): issueId is string => Boolean(issueId));
      const terminalVerdicts = await loadTerminalValidationVerdicts(db, stepRunIssueIds);
      const continuation = classifyTerminalMissionContinuation({
        missionStatus: mission.status,
        missionHasActiveHeartbeat,
        missionIssueIds: missionIssues.map((missionIssue) => missionIssue.id),
        liveWakeupIssueIds: context.terminalAlertLiveWakeupIssueIds,
        openOwnerActionRecoveryExists,
        workflowStepRows: input.group.workflowStepRows,
        validationVerdictsByIssueId: terminalVerdicts,
      });
      if (!continuation.terminal) {
        findings.push(`terminal_mission_human_operator_request_suppressed: ${input.label}; continuation remains (${continuation.suppressReason})`);
        // [escalate-suppressed watchdog] 억제 사유가 live-wakeup 계열인데 최근(24h) 사람 상정(escalate/
        //   request_input) 결정이 있으면, 실제 사람 통지가 전달됐는지 의심해야 한다(2026-08-17 GAZ:
        //   suppress 상태로 11시간 무통지). 코멘트 가시성이라도 유지한다.
        if (continuation.suppressReason === "live-wakeup-or-accepted-source-resume"
          && await hasRecentHumanEscalationDecision(db, mission.companyId, mission.id)) {
          findings.push(`escalate_pending_suppressed_watchdog: ${input.label}; a recent escalate/request_input owner decision is pending while continuation suppression (${continuation.suppressReason}) holds — verify the human notification was actually delivered`);
        }
        return;
      }
      const ownerAction = input.ownerAction ?? await input.ensureOwnerAction?.() ?? null;
      if (!ownerAction) {
        findings.push(`terminal_mission_human_operator_request_suppressed: ${input.label}; no owner-action report target`);
        return;
      }
      try {
        const retrySummary = summarizeWorkflowRetryExhaustion(
          input.group.workflowStepRows.map((row) => ({
            status: row.stepRun.status,
            metadata: row.stepRun.metadata,
          })),
        );
        const emitted = await emitTerminalMissionHumanOperatorReport(db, {
          expectedCompanyId: ownerAction.companyId,
          expectedMissionId: ownerAction.missionId ?? "",
          issue: {
            id: ownerAction.id,
            companyId: ownerAction.companyId,
            missionId: ownerAction.missionId,
            originKind: ownerAction.originKind,
            originId: ownerAction.originId,
            title: ownerAction.title,
            identifier: ownerAction.identifier,
          },
          missionTitle: mission.title,
          sourceIssueIdentifier: input.group.sourceIssue?.identifier ?? null,
          workflowRunId: input.group.workflowRunId,
          failedRuns: input.group.failedRuns,
          retryAttempts: retrySummary?.retryAttempts ?? null,
          retryMaxRetries: retrySummary?.retryMaxRetries ?? null,
          provider403Ladder: await summarizeProvider403LadderForMission(db, mission.companyId, mission.id),
        });
        if (emitted.emitted) {
          findings.push(`terminal_mission_human_operator_request_emitted: ${ownerAction.identifier ?? ownerAction.id} terminal snapshot of ${input.group.failedRuns.length} failed run(s); no executable continuation remains`);
        }
      } catch (err) {
        logger.warn({ err, issueId: ownerAction.id, missionId: mission.id }, "failed to emit terminal-mission human operator request");
      }
    };
    // Resolve recognized QA-cap actions before the generic blocked-issue loop. The QA
    // gate must own this terminal generation; otherwise supervision would create both
    // a generic [Unblock] action and the canonical [QA Cap] action for one failure.
    const qaCapOwnerActionByWorkflowRunId = new Map<string, MissionSupervisionIssue>();
    const qaCapPendingWorkflowRunIds = new Set<string>();
    const qaCapSourceIssueIds = new Set<string>();
    const capExhaustions = await detectQaReworkCapExhaustion({
      db,
      companyId: mission.companyId,
      stepRows,
    });
    for (const exhaustion of capExhaustions) {
      qaCapPendingWorkflowRunIds.add(exhaustion.workflowRunId);
      if (exhaustion.qaIssueId) qaCapSourceIssueIds.add(exhaustion.qaIssueId);
      const workflowName = stepRows.find((row) => row.run.id === exhaustion.workflowRunId)?.definition.name ?? exhaustion.workflowRunId;
      try {
        const result = await ensureQaReworkCapOversightIssue({
          db,
          mission,
          oversightIssue,
          exhaustion,
          workflowName,
          rejectTrend: await loadConsecutiveQaRejectTrend(db, mission.companyId, exhaustion.qaIssueId),
          createIssue: ownerActions.createMissionOwnerActionIssue,
          onOwnerActionCreated: deps.onOwnerActionCreated,
        });
        if (!result) {
          findings.push(`qa_rework_cap_oversight_concurrent: run=${exhaustion.workflowRunId} producer=${exhaustion.producerStepId} qa=${exhaustion.qaStepId} — claim in progress, will retry next tick`);
          continue;
        }
        qaCapOwnerActionByWorkflowRunId.set(exhaustion.workflowRunId, result.issue);
        findings.push(`qa_rework_cap_oversight: run=${exhaustion.workflowRunId} producer=${exhaustion.producerStepId} qa=${exhaustion.qaStepId} generation=${exhaustion.producerIteration}/${exhaustion.maxIterations}${result.created ? " issue_created" : " issue_exists"} issue=${result.issue.identifier ?? result.issue.id}`);
        // [qa defect layer — cap 경로 카드] cap 소진에도 동일 오너 카드를 띄운다(생성 지점 (b)).
        //   requestKey(qa-source-defect:{run}:{producer}:{iteration}) 멱등 — 계층 라우팅(a)에서 이미
        //   만든 카드면 replay/conflict 로 처리되고 여기서는 로깅만 남는다. linkIssue=[QA Cap] 오너액션
        //   이슈(assignee=mission owner) → 해결 시 기존 continuation worker 가 owner 를 wake 한다.
        try {
          const capCardFindings = exhaustion.qaIssueId
            ? await loadWorkflowApiFindings({
                db,
                companyId: mission.companyId,
                issueId: exhaustion.qaIssueId,
                workflowRunId: exhaustion.workflowRunId,
                workflowStepRunId: exhaustion.qaStepRunId,
              })
            : null;
          const cardResult = await ensureQaSourceDefectOwnerCard({
            db,
            companyId: mission.companyId,
            missionId: mission.id,
            workflowRunId: exhaustion.workflowRunId,
            producerStepId: exhaustion.producerStepId,
            iteration: exhaustion.producerIteration,
            maxIterations: exhaustion.maxIterations,
            findings: capCardFindings ?? [],
            qaRefs: [{ qaStepId: exhaustion.qaStepId, qaIssueId: exhaustion.qaIssueId }],
            linkIssueId: result.issue.id,
          });
          if (cardResult.outcome === "created" || cardResult.outcome === "replayed") {
            findings.push(`qa_source_defect_owner_card: run=${exhaustion.workflowRunId} producer=${exhaustion.producerStepId} iteration=${exhaustion.producerIteration} decision=${cardResult.decisionId} ${cardResult.outcome}`);
          } else {
            findings.push(`qa_source_defect_owner_card_${cardResult.outcome}: run=${exhaustion.workflowRunId} producer=${exhaustion.producerStepId} iteration=${exhaustion.producerIteration} — ${cardResult.message.slice(0, 200)}`);
          }
        } catch (err) {
          logger.warn({ err, missionId: mission.id, workflowRunId: exhaustion.workflowRunId }, "qa-source-defect owner card ensure failed — will retry next supervision tick");
        }
        // [repeated-defect trend] 같은 QA gate 의 연속 반려 추세 — 오너 도장 승인 방지 가시화.
        if (exhaustion.qaIssueId) {
          const trend = await loadConsecutiveQaRejectTrend(db, mission.companyId, exhaustion.qaIssueId);
          if (trend.count >= 3) {
            findings.push(`qa_repeated_reject_trend: run=${exhaustion.workflowRunId} qa issue=${exhaustion.qaIssueId} consecutive_rejects=${trend.count} — producer re-fixes are not landing; suspect a source-level root cause (renderer/template/skill), not another output patch`);
          }
        }
      } catch (err) {
        logger.warn({ err, missionId: mission.id, workflowRunId: exhaustion.workflowRunId }, "qa-cap-oversight ensure failed — will retry next supervision tick");
        findings.push(`qa_rework_cap_oversight_error: run=${exhaustion.workflowRunId} producer=${exhaustion.producerStepId} qa=${exhaustion.qaStepId} — ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
    const activePlanRefs = asRecord(activePlan?.refs);
    const activeOwnerPlanDecision = asRecord(activePlanRefs.ownerPlanDecision);
    const activePaqoWorkflow = asRecord(activePlanRefs.paqoWorkflow);
    const latestPlanDecision = await findLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: mission.companyId,
      missionId: mission.id,
    });
    const [latestPlanSubmission] = await db
      .select({
        planningIssueId: missionPlanDecisionSubmissions.planningIssueId,
        status: missionPlanDecisionSubmissions.status,
      })
      .from(missionPlanDecisionSubmissions)
      .where(and(
        eq(missionPlanDecisionSubmissions.companyId, mission.companyId),
        eq(missionPlanDecisionSubmissions.missionId, mission.id),
      ))
      .orderBy(desc(missionPlanDecisionSubmissions.createdAt))
      .limit(1);
    const rejectedPlanningIssueId = latestPlanSubmission && isRejectedMissionPlanDecisionSubmissionStatus(latestPlanSubmission.status)
      ? latestPlanSubmission.planningIssueId
      : null;
    const hasRecordedPlanDecision = Boolean(trimmedString(activeOwnerPlanDecision.decisionHash));
    const hasPaqoWorkflowRun = Boolean(trimmedString(activePaqoWorkflow.workflowRunId)) || Boolean(await loadRevisionBoardWait(db, mission.companyId, mission.id));
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

    const findPlanSubmissionMissingCandidate = async (): Promise<{
      kind: "missing";
      planIssue: MissionSupervisionIssue;
      succeededRun: MissionSupervisionHeartbeatRun;
      markerText: string;
      idempotencyKey: string;
    } | {
      kind: "rejected";
      planIssue: MissionSupervisionIssue;
      succeededRun: MissionSupervisionHeartbeatRun | null;
      decisionHash: string;
      rejectionReason: string | null;
      diagnostics: unknown;
      previousDecision: unknown;
      candidateRoster: MissionExecutionCandidate[];
      markerText: string;
      idempotencyKey: string;
      candidateRosterLines: string[];
      retryAllowed: boolean;
    } | null> => {
      if (mission.status !== "planning" && !(input.applySafeActions === true && mission.status === "active"
        && (missionScope?.status === "planning" || promotedFromPlanning))) return null;

      const planIssue = missionIssues.find((issue) => (
        issue.originKind === "mission_main_executor_plan" &&
        !issue.hiddenAt &&
        isPlanSubmissionRecoveryIssueStatus(issue.status)
      ));
      if (!planIssue) return null;

      const [existingSubmission] = await db
        .select({
          id: missionPlanDecisionSubmissions.id,
          status: missionPlanDecisionSubmissions.status,
          decisionHash: missionPlanDecisionSubmissions.decisionHash,
          rejectionReason: missionPlanDecisionSubmissions.rejectionReason,
          diagnostics: missionPlanDecisionSubmissions.diagnostics,
          decision: missionPlanDecisionSubmissions.decision,
        })
        .from(missionPlanDecisionSubmissions)
        .where(and(
          eq(missionPlanDecisionSubmissions.companyId, mission.companyId),
          eq(missionPlanDecisionSubmissions.missionId, mission.id),
        ))
        .orderBy(desc(missionPlanDecisionSubmissions.createdAt))
        .limit(1);
      if (existingSubmission) {
        if (!isRejectedMissionPlanDecisionSubmissionStatus(existingSubmission.status)) return null;
        const candidates = await listCompanyExecutionCandidates(db, mission.companyId);
        const rosterFingerprint = candidateRosterFingerprint(candidates);
        const candidateRosterLines = formatCandidateRosterLines(candidates, mission.ownerAgentId);
        const markerText = `mission-owner-plan-submission-rejected:${mission.id}:${planIssue.id}:prompt-${REJECTED_PLAN_RECOVERY_PROMPT_REVISION}:roster-${rosterFingerprint}`;
        const retryAllowed = !await hasRecoveryIdempotency(db, mission.companyId, markerText);
        if (missionHasActiveHeartbeat) return null;
        const rejectedMissionIssueIds = missionIssues.map((issue) => issue.id);
        const rejectedWakeupScope = rejectedMissionIssueIds.length > 0
          ? or(eq(agentWakeupRequests.missionId, mission.id), inArray(agentWakeupRequests.issueId, rejectedMissionIssueIds))
          : eq(agentWakeupRequests.missionId, mission.id);
        const [rejectedActiveWakeup] = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, mission.companyId),
            inArray(agentWakeupRequests.status, ["queued", "claimed"]),
            rejectedWakeupScope,
          ))
          .limit(1);
        if (rejectedActiveWakeup) return null;
        const latestTerminalRun = (heartbeatRunsByIssueId.get(planIssue.id) ?? [])
          .filter((run) => run.status === "succeeded" || run.status === "failed" || run.status === "timed_out")
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
        return {
          kind: "rejected",
          planIssue,
          succeededRun: latestTerminalRun,
          decisionHash: existingSubmission.decisionHash,
          rejectionReason: existingSubmission.rejectionReason,
          diagnostics: existingSubmission.diagnostics,
          previousDecision: existingSubmission.decision,
          candidateRoster: candidates,
          markerText,
          idempotencyKey: markerText,
          candidateRosterLines,
          retryAllowed,
        };
      }

      // missing 경로: planning run 성공 후 submission 대기. succeededRun 요구(기존).
      const succeededRun = (heartbeatRunsByIssueId.get(planIssue.id) ?? [])
        .filter((run) => run.status === "succeeded")
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      if (!succeededRun) return null;

      if (missionHasActiveHeartbeat) return null;

      const missionIssueIds = missionIssues.map((issue) => issue.id);
      const wakeupScope = missionIssueIds.length > 0
        ? or(eq(agentWakeupRequests.missionId, mission.id), inArray(agentWakeupRequests.issueId, missionIssueIds))
        : eq(agentWakeupRequests.missionId, mission.id);
      const [activeWakeup] = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, mission.companyId),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          wakeupScope,
        ))
        .limit(1);
      if (activeWakeup) return null;

      const [existingWorkflowRun] = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)))
        .limit(1);
      if (existingWorkflowRun) return null;

      const hasPlanQaIssue = missionIssues.some((issue) => (
        issue.originKind === "mission_plan_qa" && !issue.hiddenAt
      ));
      if (hasPlanQaIssue) return null;

      const markerText = `mission-owner-plan-submission-missing:${mission.id}:${planIssue.id}:${succeededRun.id}`;
      if (await hasRecoveryIdempotency(db, mission.companyId, markerText)) return null;

      return {
        kind: "missing",
        planIssue,
        succeededRun,
        markerText,
        idempotencyKey: `mission-owner-plan-submission-missing:${mission.id}:${planIssue.id}:${succeededRun.id}`,
      };
    };

    const planSubmissionMissingCandidate = await findPlanSubmissionMissingCandidate();
    if (planSubmissionMissingCandidate) {
      const diagnosticsSummary = planSubmissionMissingCandidate.kind === "rejected"
        ? formatMissionPlanDecisionSubmissionDiagnostics(planSubmissionMissingCandidate.diagnostics)
        : "";
      const rejectedPlanRetryExhausted = planSubmissionMissingCandidate.kind === "rejected" && !planSubmissionMissingCandidate.retryAllowed;
      findings.push(planSubmissionMissingCandidate.kind === "rejected"
        ? `${rejectedPlanRetryExhausted ? "plan_submission_rejected_retry_exhausted" : "plan_submission_rejected"}: planning_issue=${planSubmissionMissingCandidate.planIssue.identifier ?? planSubmissionMissingCandidate.planIssue.id} decision_hash=${planSubmissionMissingCandidate.decisionHash} reason=${planSubmissionMissingCandidate.rejectionReason ?? "unknown"}${diagnosticsSummary ? ` diagnostics=${diagnosticsSummary}` : ""}`
        : `plan_submission_missing: planning_issue=${planSubmissionMissingCandidate.planIssue.identifier ?? planSubmissionMissingCandidate.planIssue.id} succeeded_run=${planSubmissionMissingCandidate.succeededRun.id}`);
      if (planSubmissionMissingCandidate.kind === "missing") {
        // Phase 5 (plan 8.1 oversight stall): auto-create a company-scoped quality review item.
        // Awaited + try/catch so the quality board is observable/testable but never blocks supervision on its own failure.
        try {
          await qSvc.createOversightStallReviewItem({
            companyId: mission.companyId,
            missionId: mission.id,
            missionTitle: mission.title,
          });
        } catch {
          // swallowed intentionally: supervision must not depend on the quality board.
        }
      }
      addRecommendation({
        type: planSubmissionMissingCandidate.kind === "rejected" ? "plan_submission_rejected" : "plan_submission_missing",
        missionId: mission.id,
        issueId: planSubmissionMissingCandidate.planIssue.id,
        reason: planSubmissionMissingCandidate.kind === "rejected"
          ? rejectedPlanRetryExhausted
            ? `Latest Mission owner plan decision submission was already retried with unchanged execution candidates; automatic retry is stopped until the mission owner changes the plan or available execution resources${diagnosticsSummary ? `; diagnostics: ${diagnosticsSummary}` : ""}`
            : `Latest Mission owner plan decision submission was rejected (${planSubmissionMissingCandidate.rejectionReason ?? "unknown"}); the mission owner must revise the decision before Plan QA or workflow materialization can continue${diagnosticsSummary ? `; diagnostics: ${diagnosticsSummary}` : ""}`
          : "Planning run succeeded, but no structured Mission owner plan decision submission was recorded; the mission owner must submit the decision block before Plan QA or workflow materialization can start",
        safeToAutoApply: planSubmissionMissingCandidate.kind !== "rejected" || planSubmissionMissingCandidate.retryAllowed,
      });
    }

    // [목적] graphWorkProductRequired producer가 blocked 되었으나 workProduct 등록이 안 됐고,
    //   기대 산출물 파일은 디스크에 이미 존재하며, 최근 recovery(unblock) issue가 timed_out/failed
    //   로 stalled 된 경우 — 댓글만 남기지 않고 producer를 깨워 "기존 파일 재사용 + [ARTIFACT]: <path>
    //   마지막 줄로 등록 완료" 시그널을 보낸다. idempotency: marker + idempotency key.
    // [수정시 영향] wake 폭주 방지가 생명. marker/key/findExistingWorkflowResumeWake( app.ts wiring ) 의존.
    const findExistingArtifactFile = (stepOutputDir: string): string | null => {
      for (const name of ["index.html", "report.md", "evidence.json"]) {
        const candidate = path.join(stepOutputDir, name);
        try {
          if (existsSync(candidate)) return candidate;
        } catch {
          // 권한/디렉토리 부재 등 stat 실패 = 파일 없음 취급
        }
      }
      return null;
    };

    const tryDispatchWorkProductReuseWake = async (input: {
      sourceIssue: MissionSupervisionIssue;
      sourceLabel: string;
    }): Promise<void> => {
      if (!deps.onWorkProductReuseWakeRequested) return;
      const { sourceIssue, sourceLabel } = input;
      const producerAgentId = sourceIssue.assigneeAgentId;
      if (!producerAgentId) return;

      // [1318] same-run DAG 의 downstream QA gate(source 를 dependency 로 갖는 QA step) 식별 시에만
      //   ownership guard. downstream QA 없으면 bounded registration 허용(과도 차단 방지, codex review).
      const sourceStepRowsForReuse = stepRowsByIssueId.get(sourceIssue.id) ?? [];
      const sourceStepRowForReuse = sourceStepRowsForReuse[0];
      const stepsForReuse = (sourceStepRowForReuse?.definition?.stepsJson ?? null) as DagStepLike[] | null;
      const sourceStepIdForReuse = sourceStepRowForReuse?.stepRun?.stepId ?? null;
      const downstreamQaStep = Array.isArray(stepsForReuse) && sourceStepIdForReuse
        ? stepsForReuse.find((s) => isQaLikeStep(s as Parameters<typeof isQaLikeStep>[0])
            && ((((s as { dependencies?: string[] }).dependencies) ?? ((s as { dependsOn?: string[] }).dependsOn) ?? []).includes(sourceStepIdForReuse)))
        : null;
      if (downstreamQaStep && sourceStepRowForReuse) {
        const qaStepRowForReuse = stepRows.find((r) =>
          r.stepRun.stepId === (downstreamQaStep as { id?: string }).id
          && r.run.id === sourceStepRowForReuse.run.id);
        const downstreamQaGateId = qaStepRowForReuse?.stepRun.issueId ?? null;
        if (downstreamQaGateId) {
          const reuseOwnership = await resolveRecoveryOwnership(db, {
            companyId: mission.companyId,
            missionId: mission.id,
            sourceIssueId: sourceIssue.id,
            qaGateIssueId: downstreamQaGateId,
          });
          if (isQaRecoveryLive(reuseOwnership)) {
            findings.push(`workproduct_reuse_qa_recovery_live: ${sourceLabel} ownership=qa_recovery_live signal=${reuseOwnership.signal} — registration wake deferred to QA recovery owner`);
            return;
          }
        }
      }

      // (1) graphWorkProductRequired producer step run for this issue
      const stepRowsForIssue = stepRowsByIssueId.get(sourceIssue.id) ?? [];
      const producerStepRow = stepRowsForIssue.find(
        (row) => asRecord(row.stepRun.metadata)?.graphWorkProductRequired === true,
      );
      if (!producerStepRow) return;

      // (2) no registered workProduct yet
      const registeredWorkProducts = await workProductService(db).listForIssue(sourceIssue.id);
      if (registeredWorkProducts.length > 0) return;

      // (3) recent stalled recovery (mission_main_executor_unblock for this source with a
      //     timed_out/failed heartbeat run) — owner가 시도했으나 run이 죽은 상태
      let stalledRecoveryIssue: MissionSupervisionIssue | null = null;
      let stalledRun: MissionSupervisionHeartbeatRun | null = null;
      for (const candidateIssue of missionIssues) {
        if (candidateIssue.originKind !== "mission_main_executor_unblock") continue;
        if (candidateIssue.originId !== sourceIssue.id) continue;
        const runs = (heartbeatRunsByIssueId.get(candidateIssue.id) ?? [])
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const failed = runs.find(
          (run) => run.status === "timed_out" || run.status === "failed" || run.errorCode === "execution_stale_timeout",
        );
        if (failed) {
          stalledRecoveryIssue = candidateIssue;
          stalledRun = failed;
          break;
        }
      }
      if (!stalledRecoveryIssue || !stalledRun) return;

      // (4) 기대 산출물 파일이 stepOutputDir 에 실제 존재 — 파일이 없으면 자동 success 금지,
      //     기존 comment/replan 경로에 맡김
      const workProductPaths = await resolveMissionWorkProductPaths(db, {
        companyId: mission.companyId,
        missionId: mission.id,
        // projectId 생략(null) — 회사 workProductRoot 가 우선이라 stepOutputDir 경로는 동일.
        // dag-engine 도 company root 우선으로 조립하므로 producer 가 쓴 경로와 일치.
        projectId: null,
        workflowRunId: producerStepRow.run.id,
        stepId: producerStepRow.stepRun.stepId,
      });
      const stepOutputDir = workProductPaths?.stepOutputDir ?? null;
      if (!stepOutputDir) return;
      const artifactPath = findExistingArtifactFile(stepOutputDir);
      if (!artifactPath) return;

      // (5) idempotency — 같은 source+artifact 에 대한 이미 발송된 wake면 skip
      const idempotencyKey = buildWorkProductReuseWakeIdempotencyKey({
        missionId: mission.id,
        sourceIssueId: sourceIssue.id,
        artifactPath,
      });
      if (await hasRecoveryIdempotency(db, mission.companyId, idempotencyKey)) return;

      // (6) 발송: 재사용 지시 댓글 + producer wake (app.ts 가 heartbeat.wakeup 으로 연결,
      //     findExistingWorkflowResumeWake 로 중복 wake 방지)
      try {
        const wakeComment = await issueService(db).addComment(
          sourceIssue.id,
          buildWorkProductReuseWakeDispatchedComment({ language: supervisionLanguage,
            missionId: mission.id,
            sourceIssueId: sourceIssue.id,
            sourceLabel,
            artifactPath,
            stalledRecoveryIssueId: stalledRecoveryIssue.id,
            stalledRunId: stalledRun.id,
            stalledRunStatus: stalledRun.status,
            targetAgentId: producerAgentId,
            idempotencyKey,
          }),
          { agentId: mission.ownerAgentId },
        );
        await deps.onWorkProductReuseWakeRequested({
          mission,
          sourceIssue,
          targetAgentId: producerAgentId,
          artifactPath,
          stalledRecoveryIssueId: stalledRecoveryIssue.id,
          stalledRun: stalledRun,
          idempotencyKey,
          wakeCommentId: wakeComment.id,
        });
        await recordRecoveryAction({
          db,
          companyId: mission.companyId,
          missionId: mission.id,
          issueId: sourceIssue.id,
          sourceIssueId: sourceIssue.id,
          workflowRunId: producerStepRow.run.id,
          workflowStepRunId: producerStepRow.stepRun.id,
          stepId: producerStepRow.stepRun.stepId,
          idempotencyKey,
          eventType: "mission_workproduct_reuse_wakeup",
          decision: "recover_artifact",
          resultStatus: sourceIssue.status,
        });
        findings.push(`workproduct_reuse_wakeup_dispatched: ${sourceLabel} blocked graphWorkProductRequired producer has no registered workProduct, but deliverable ${artifactPath} exists and recovery ${stalledRecoveryIssue.id} stalled (run ${stalledRun.id} ${stalledRun.status}); dispatched reuse wake to agent ${producerAgentId}`);
        appliedActions.push({
          type: "workproduct_reuse_wakeup",
          missionId: mission.id,
          sourceIssueId: sourceIssue.id,
          artifactPath,
          stalledRecoveryIssueId: stalledRecoveryIssue.id,
          stalledRunId: stalledRun.id,
          resultStatus: sourceIssue.status,
          idempotencyKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push(`workproduct_reuse_wakeup_failed: ${sourceLabel} reuse wake dispatch failed — ${message}`);
      }
    };

  // 뒤 단계(per-issue 루프·workflow 복구·정리)가 쓰는 값·클로저만 넘긴다.
  return {
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
  };
}
