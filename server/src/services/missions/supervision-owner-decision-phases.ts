// server/src/services/missions/supervision-owner-decision-phases.ts
//
// [수정시 주의] main executor supervision 의 per-issue 루프 **안**에서 structured owner decision 하나를
// 적용하는 단계 묶음. supervision-main.ts 의 runMainExecutorSupervision 안 `if (ownerDecision)` 블록
// (원본 655-1515)을 본문 변경 없이 옮긴 모듈이다. 회귀 시 mission test + workflow-dag-engine test 필수.
// 이 모듈이 하는 일: ledger 의 권위 있는 owner decision(또는 grace window auto-default) 하나를 받아
//   (1) retry_source_issue — retry lock 획득, source issue 재디스패치/wakeup, 실패 wakeup 결과 기록,
//   (2) reassign_source_issue·replan·producer rework — 위임 판정과 실제 적용,
//   (3) QA gate 재큐·dead-target 휴먼 에스컬레이션·recovery marker claim 같은 안전 동기화,
//   (4) 그 밖의 decision(wait/no-action 등)에 대한 recommendation 기록.
// 원본은 루프 변수(issue·label·comments)와 runMainExecutorSupervision 의 클로저 값을 그대로 읽었으므로,
// 여기서는 입력을 MissionOwnerDecisionPhaseInputs 하나로 받는다. 반환값은 없다 — 이 블록은 값을 돌려주지
// 않고 findings·appliedActions 배열과 ownerActions 같은 **호출부와 같은 객체**를 직접 갱신한다.
// 원본이 루프 안 블록이었으므로 이 구간에서 continue/return 으로 루프·함수를 벗어나는 경로는 없다
// (구간 밖 제어 이동 0건). 따라서 호출부는 이 함수 뒤에 원래대로 다음 코드를 이어서 실행한다.
// missionHasNativeLoop 만 원본에서 이 블록 밖(:584)에 `let ... = false` 로 선언되어 있고 :724 에서만
// 대입되며, 읽기는 :761·:765·:1281 뿐이라 모두 이 구간 안이다(호출부는 이후 읽지 않는다).
// 그래서 이 모듈에서 같은 초기값으로 다시 선언해도 의미가 같다 — 그 줄이 아래 한 줄이다.
// 입력 필드를 바꾸면 supervision-main.ts 의 호출 인자도 함께 고쳐야 한다(타입 검사가 잡는다).
import { agentWakeupRequests, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import type { createOwnerActions } from "./owner-actions.js";
import { LIVE_WAKEUP_STATUSES } from "./owner-action-unblock-handback.js";
import type { MissionServiceDeps } from "../missions.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
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
import { buildRetrySourceIssueComment, buildRetrySourceIssueRequestChangesContextComment, buildRetrySourceIssueWakeupResultComment, extractLatestRequestChangesSummary, isTerminalIssueStatus, summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js";
import { normalizeMissionOwnerDecisionWakeupDispatchResult,
  type MissionOwnerDecisionWakeupDispatchStatus,
  type MissionOwnerSupervisionAppliedAction,
  type MissionOwnerSupervisionRecommendation } from "./supervision-types.js";
import { activePlanRecoveryGateReason, resolveProducerStepIdFromDag, type DagStepLike } from "./supervision-helpers.js";
import { requeueStaleValidationGateBeforeOwnerRetry } from "./validation-gate-requeue.js";
import { applyReassignSourceIssueDecision } from "./mission-owner-reassign-source.js";
import { applyOwnerReplanDecision } from "./owner-replan-application.js";
import { resolveRecoveryOwnership, isQaRecoveryLive } from "./recovery-ownership-guard.js";
import { authorizeProducerRework } from "./producer-rework-authorization.js";
import { extractQaCapQaStepId, isQaReworkCapOversightIssue } from "./qa-rework-cap-oversight.js";
import type { buildMissionSupervisionContext, MissionSupervisionIssue } from "./mission-supervision-context.js";
import type { SystemLanguage } from "./system-language.js";
import type { MissionOwnerDecisionRecord } from "./mission-owner-decision-contract.js";
import type { ExtractedMissionOwnerDecision } from "./mission-owner-recovery-events.js";
import {
  readWakeupResultDetailReason,
  resolveQaGateIssueId,
  loadActiveWorkProductUpdatedAt,
  hasRecoveryIdempotency,
  DISPATCHED_RECOVERY_WAKEUP_STATUSES,
  hasDispatchedRecoveryWakeup,
  recordRecoveryAction,
  claimSupervisionMarkerOnce,
  loadActiveSourceIssueWorkProducts,
} from "./supervision-support.js";

/** 이 단계가 바깥에서 받는 입력. 원본 runMainExecutorSupervision 의 클로저 값과 루프 변수를 그대로 옮겼다. */
export interface MissionOwnerDecisionPhaseInputs {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
  /** 원본 input 중 이 구간이 읽는 필드만(applyOwnerDecisionActions·dispatchOwnerDecisionWakeups). */
  input: { applyOwnerDecisionActions?: boolean; dispatchOwnerDecisionWakeups?: boolean };
  /** context 중 이 구간은 mission·missionIssues·missionIssueById·commentsByIssueId·heartbeatRunsByIssueId·liveWakeupIssueIds·stepRows·stepRowsByIssueId·activePlan 만 읽는다. */
  context: Awaited<ReturnType<typeof buildMissionSupervisionContext>>;
  supervisionLanguage: SystemLanguage;
  oversightIssue: MissionSupervisionIssue;
  now: Date;
  /** findings·appliedActions 는 호출부와 같은 배열 객체를 그대로 받아 쌓는다. */
  findings: string[];
  addRecommendation: (recommendation: MissionOwnerSupervisionRecommendation) => void;
  appliedActions: MissionOwnerSupervisionAppliedAction[];
  missionHasActiveHeartbeat: boolean;
  /** per-issue 루프 변수와 그 파생 값. */
  issue: MissionSupervisionIssue;
  label: string;
  comments: string[];
  /** 구조 기록 조회 결과. 원본과 같이 null 이 가능하고, 본문이 ?./! 로 다룬다. */
  decisionRecord: MissionOwnerDecisionRecord | null;
  ownerDecision: ExtractedMissionOwnerDecision;
  /** owner 가 결정을 쓰지 않아 grace window 로 자동 default 된 경우. */
  autoDefaulted: boolean;
}

export async function runMissionOwnerDecisionPhases({
  db,
  deps,
  ownerActions,
  input,
  context,
  supervisionLanguage,
  oversightIssue,
  now,
  findings,
  addRecommendation,
  appliedActions,
  missionHasActiveHeartbeat,
  issue,
  label,
  comments,
  decisionRecord,
  ownerDecision,
  autoDefaulted,
}: MissionOwnerDecisionPhaseInputs): Promise<void> {
  let missionHasNativeLoop = false;
  const { mission, missionIssues, missionIssueById, commentsByIssueId, heartbeatRunsByIssueId, liveWakeupIssueIds, stepRows, stepRowsByIssueId, activePlan } = context;
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
