// server/src/services/missions/owner-action-unblock-handback.ts
//
// [파일 목적] mission_main_executor_unblock 완료 시 source 를 직접 checkout/재시도 하지 않기 위한
//   evidence + native 분류 + display report 빌드 + system ledger 검증 헬퍼.
// [주요 흐름]
//   gatherUnblockSourceEvidence → deriveUnblockDispatchClassification → buildUnblockHandbackReportComment.
//   done closeout 은 validateUnblockHandbackLedgerDetails / unblockIssueHasValidatedHandbackReport 만 권위.
// [계약] recovery 는 native workflow_resume 또는 report-only. comment 본문은 closeout 권위 아님.
// [수정시 영향] LIVE_* / FAILED_RUN / failureClass 변경 시 done guard 와 Phase D 정렬 필요.
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, not, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowStepRuns,
  missions,
} from "@paperclipai/db";
import { findExistingWorkflowResumeWake } from "../workflow-resume-wake.js";
import { heartbeatService } from "../heartbeat.js";
import type { SourceIssueNativeResumeOutcome, SourceIssueNativeResumeReportReason } from "../workflow/source-issue-native-resume.js";

// Oversight/Phase D stopped 판정과 공유하는 "live" 상태 집합. 이 집합에 있으면 실행 큐에 진입한/
// 진행 중인 작업이므로 stopped/직접 재시도 대상이 아니다.
export const LIVE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution", "coalesced"] as const;
const LIVE_RUN_STATUSES = ["queued", "running"] as const;
// timed_out 포함: failed/error/cancelled/timed_out 모두 종료 실패 신호.
const FAILED_RUN_STATUSES = ["failed", "error", "cancelled", "timed_out"] as const;

// Display report marker only — closeout authority is the system handback ledger, not comment text.
export const UNBLOCK_HANDBACK_REPORT_MARKER = "[owner-action-handback-report]";
export const UNBLOCK_HANDBACK_LEDGER_ACTION = "issue.owner_action_unblock_handback_queued";

// guard parser 가 인정하는 failureClass / recommendedNativeAction 값 집합(외국값/마커만 주입 거부).
export const UNBLOCK_FAILURE_CLASSES = new Set([
  "recovered",
  "blocked_native_resume_in_flight",
  "blocked_no_live_run",
  "blocked_no_native_step",
  "blocked_native_run_not_running",
  "blocked_no_native_definition",
  "blocked_native_step_not_found",
  "blocked_native_wake_rejected",
]);
export const UNBLOCK_RECOMMENDED_NATIVE_ACTIONS = new Set([
  "workflow_resume",
  "native_resume_in_flight",
  "report_only",
]);

export type UnblockDispatchKind =
  | "workflow_resume"
  | "native_resume_in_flight"
  | "report_only";

export interface UnblockSourceEvidence {
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  sourceStatus: string;
  sourceAssigneeAgentId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  stepId: string | null;
  failedRunId: string | null;
  failedRunStatus: string | null;
  failedRunTimedOut: boolean;
  failedRunError: string | null;
  failedRunErrorCode: string | null;
  failedRunExitCode: number | null;
  liveRunId: string | null;
  liveWakeupRequestId: string | null;
}

// native outcome → failureClass·recommendedNativeAction 단일 매핑. evidence.facts 는 참고용.
export interface UnblockDispatchClassification {
  failureClass: string;
  recommendedNativeAction: UnblockDispatchKind;
  nativeReportReason: SourceIssueNativeResumeReportReason | null;
  workflowDefinitionId: string | null;
}

type IssueRow = typeof issues.$inferSelect;

export async function gatherUnblockSourceEvidence(
  db: Db,
  input: { companyId: string; source: IssueRow },
): Promise<UnblockSourceEvidence> {
  const source = input.source;

  const stepRun = await db
    .select({
      workflowStepRunId: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, source.id))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // live run 감지용 최근 run(queued/running 이면 live).
  const lastRun = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, source.id),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const liveRun = lastRun && LIVE_RUN_STATUSES.includes(lastRun.status as typeof LIVE_RUN_STATUSES[number])
    ? lastRun
    : null;

  // [req] failed-run evidence 는 단순히 latest run 이 아니라 "가장 최근의 실패한 run" 이어야 한다 —
  //   최근에 succeeded run 이 있어도 직전 실패가 회복 원인일 수 있으므로. timed_out/error/errorCode/
  //   nonzero-exit 신호를 포함해 newest FAILED run 을 가져온다.
  const failedRun = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      exitCode: heartbeatRuns.exitCode,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.issueId, source.id),
      or(
        inArray(heartbeatRuns.status, [...FAILED_RUN_STATUSES]),
        isNotNull(heartbeatRuns.error),
        isNotNull(heartbeatRuns.errorCode),
        ne(heartbeatRuns.exitCode, 0),
      ),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // [req] source assignee 가 없어도 live wake 판정은 동작해야 한다(report-only 도 source assignee
  //   없이 수행되므로). (company, issue) 단위로 모든 live wake 상태를 본다.
  const liveWake = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, source.id),
      inArray(agentWakeupRequests.status, [...LIVE_WAKEUP_STATUSES]),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const existingNativeResume = source.assigneeAgentId
    ? await findExistingWorkflowResumeWake(db, {
        companyId: input.companyId,
        agentId: source.assigneeAgentId,
        issueId: source.id,
      })
    : null;

  // evidence 객체엔 분류(failureClass/recommended)를 두지 않는다 — 분류는 outcome 기반으로
  // deriveUnblockDispatchClassification 에서 단일 계산된다(드리프트 방지).
  return {
    sourceIssueId: source.id,
    sourceIssueIdentifier: source.identifier ?? null,
    sourceStatus: source.status,
    sourceAssigneeAgentId: source.assigneeAgentId,
    workflowRunId: stepRun?.workflowRunId ?? null,
    workflowStepRunId: stepRun?.workflowStepRunId ?? null,
    stepId: stepRun?.stepId ?? null,
    failedRunId: failedRun?.id ?? null,
    failedRunStatus: failedRun?.status ?? null,
    failedRunTimedOut: failedRun?.status === "timed_out",
    failedRunError: failedRun?.error ?? null,
    failedRunErrorCode: failedRun?.errorCode ?? null,
    failedRunExitCode: failedRun?.exitCode ?? null,
    liveRunId: liveRun?.id ?? null,
    liveWakeupRequestId: liveWake?.id ?? existingNativeResume?.id ?? null,
  };
}

// [목적] native DAG 헬퍼 outcome 을 failureClass·recommendedNativeAction 로 정규화. outcome 이
//   authority 이므로 evidence 의 사전 추정을 덮어쓴다. recovered(source 더 이상 blocked 아님)는
//   outcome 과 무관하게 report_only.
// [입력] evidence(facts), outcome(null = source 가 blocked 이 아니거나 dispatch 시도 안 한 경우).
export function deriveUnblockDispatchClassification(
  evidence: UnblockSourceEvidence,
  outcome: SourceIssueNativeResumeOutcome | null,
): UnblockDispatchClassification {
  if (evidence.sourceStatus !== "blocked" || !outcome) {
    return {
      failureClass: "recovered",
      recommendedNativeAction: "report_only",
      nativeReportReason: null,
      workflowDefinitionId: null,
    };
  }
  switch (outcome.kind) {
    case "dispatched":
      return {
        failureClass: "blocked_no_live_run",
        recommendedNativeAction: "workflow_resume",
        nativeReportReason: null,
        workflowDefinitionId: outcome.workflowDefinitionId,
      };
    case "already_in_flight":
      return {
        failureClass: "blocked_native_resume_in_flight",
        recommendedNativeAction: "native_resume_in_flight",
        nativeReportReason: null,
        workflowDefinitionId: null,
      };
    // cap-override outcomes are owner-action retry paths; they never reach this Unblock-completion
    //   flow (which dispatches without ownerAction), but the union must stay exhaustive.
    case "cap_override_applied":
      return {
        failureClass: "blocked_no_live_run",
        recommendedNativeAction: "workflow_resume",
        nativeReportReason: null,
        workflowDefinitionId: outcome.workflowDefinitionId,
      };
    case "cap_override_already_applied":
      return {
        failureClass: "blocked_native_resume_in_flight",
        recommendedNativeAction: "native_resume_in_flight",
        nativeReportReason: null,
        workflowDefinitionId: null,
      };
    case "report_only": {
      // reason → failureClass 매핑. no_step_run 만 기존 "blocked_no_native_step" 라벨 유지.
      const failureClass = outcome.reason === "no_step_run"
        ? "blocked_no_native_step"
        : outcome.reason === "run_not_running"
          ? "blocked_native_run_not_running"
          : outcome.reason === "no_definition"
            ? "blocked_no_native_definition"
            : outcome.reason === "step_not_found"
              ? "blocked_native_step_not_found"
              : "blocked_native_wake_rejected";
      return {
        failureClass,
        recommendedNativeAction: "report_only",
        nativeReportReason: outcome.reason,
        workflowDefinitionId: null,
      };
    }
  }
}

export function buildUnblockHandbackReportComment(
  evidence: UnblockSourceEvidence,
  classification: UnblockDispatchClassification,
  dispatchedWakeupRequestId: string | null,
  oversightWakeupRequestId: string | null = null,
): string {
  const label = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? "none" : String(v));
  return [
    UNBLOCK_HANDBACK_REPORT_MARKER,
    "Structured Oversight handback report. Do not checkout or retry the source issue directly;",
    "recovery is initiated only by Oversight/native workflow_resume. Source status is unchanged by this report.",
    "",
    `sourceIssueId: ${evidence.sourceIssueId}`,
    `sourceIssueIdentifier: ${label(evidence.sourceIssueIdentifier)}`,
    `sourceStatus: ${evidence.sourceStatus}`,
    `failedRunId: ${label(evidence.failedRunId)}`,
    `failedRunStatus: ${label(evidence.failedRunStatus)}`,
    `failedRunTimedOut: ${label(evidence.failedRunTimedOut)}`,
    `failedRunError: ${label(evidence.failedRunError)}`,
    `failedRunErrorCode: ${label(evidence.failedRunErrorCode)}`,
    `failedRunExitCode: ${label(evidence.failedRunExitCode)}`,
    `failureClass: ${classification.failureClass}`,
    `evidence:`,
    `- workflowRunId: ${label(evidence.workflowRunId)}`,
    `- workflowDefinitionId: ${label(classification.workflowDefinitionId)}`,
    `- workflowStepRunId: ${label(evidence.workflowStepRunId)}`,
    `- stepId: ${label(evidence.stepId)}`,
    `- liveRunId: ${label(evidence.liveRunId)}`,
    `- liveWakeupRequestId: ${label(evidence.liveWakeupRequestId)}`,
    `- sourceAssigneeAgentId: ${label(evidence.sourceAssigneeAgentId)}`,
    `sourceLiveRunWakeState: ${evidence.liveRunId || evidence.liveWakeupRequestId ? "live" : "none"}`,
    `recommendedNativeAction: ${classification.recommendedNativeAction}`,
    `nativeReportReason: ${label(classification.nativeReportReason)}`,
    `dispatchedWakeupRequestId: ${label(dispatchedWakeupRequestId)}`,
    `oversightHandbackWakeupRequestId: ${label(oversightWakeupRequestId)}`,
  ].join("\n");
}

export type UnblockHandbackLedgerDetails = {
  readonly sourceIssueId: string;
  readonly failureClass: string;
  readonly sourceLiveRunWakeState: "live" | "none";
  readonly recommendedNativeAction: string;
  readonly failedRunId?: string | null;
  readonly workflowRunId?: string | null;
  readonly workflowStepRunId?: string | null;
  readonly stepId?: string | null;
  readonly missionId?: string | null;
  readonly oversightIssueId?: string | null;
  readonly wakeupRequestId?: string | null;
  /** Display/audit linkage only — never read back as closeout authority. */
  readonly reportCommentId?: string | null;
};

/**
 * Validate structured handback facts stored on the system-authored activity ledger.
 * Comments are never authority for done closeout.
 */
export function validateUnblockHandbackLedgerDetails(
  details: unknown,
  expectedSourceIssueId: string,
): details is UnblockHandbackLedgerDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  const sourceIssueId = typeof record.sourceIssueId === "string" ? record.sourceIssueId : null;
  const failureClass = typeof record.failureClass === "string" ? record.failureClass : null;
  const sourceLiveRunWakeState = record.sourceLiveRunWakeState === "live" || record.sourceLiveRunWakeState === "none"
    ? record.sourceLiveRunWakeState
    : null;
  const recommendedNativeAction = typeof record.recommendedNativeAction === "string"
    ? record.recommendedNativeAction
    : null;
  if (!sourceIssueId || !failureClass || !sourceLiveRunWakeState || !recommendedNativeAction) return false;
  if (sourceIssueId !== expectedSourceIssueId) return false;
  if (!UNBLOCK_FAILURE_CLASSES.has(failureClass)) return false;
  if (!UNBLOCK_RECOMMENDED_NATIVE_ACTIONS.has(recommendedNativeAction)) return false;
  return true;
}

// done closeout guard 진입점: system-authored UNBLOCK_HANDBACK_LEDGER_ACTION details only.
//   expectedSourceIssueId 는 guard 의 originId(source). 외국 source 거부. comment 본문은 읽지 않음.
export async function unblockIssueHasValidatedHandbackReport(
  db: Db,
  input: { companyId: string; unblockIssueId: string; expectedSourceIssueId: string },
): Promise<boolean> {
  const ledgers = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, UNBLOCK_HANDBACK_LEDGER_ACTION),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.unblockIssueId),
      eq(activityLog.actorType, "system"),
      eq(activityLog.actorId, "owner-action-unblock-handback"),
    ));
  return ledgers.some((ledger) => validateUnblockHandbackLedgerDetails(ledger.details, input.expectedSourceIssueId));
}

// [목적] report-only 경로에서 구조화 report 를 쓴 직후, 기존 Oversight owner work item(mission
//   의 mission_main_executor_oversight issue)을 일반 실행 큐(heartbeat.wakeup → agent_wakeup_requests)
//   로 즉시 깨운다. 다음 supervision timer 까지 기다리지 않고 owner 가 report 를 바로 보게 한다.
//   source assignee 가 없어도 동작한다(owner 를 깨운다). queue evidence(wakeup id) 를 반환.
// [계약] forbidden retry reason(mission_owner_*_retry_source_issue) 사용 금지 — 이건 generic
//   oversight handback wake 다. source status / checkout 변경 없음.
export async function handUnblockReportToOversightOwner(
  db: Db,
  input: {
    companyId: string;
    missionId: string | null;
    unblockIssueId: string;
    reportCommentId: string | null;
    handback: {
      sourceIssueId: string;
      failureClass: string;
      sourceLiveRunWakeState: "live" | "none";
      recommendedNativeAction: string;
      failedRunId?: string | null;
      workflowRunId?: string | null;
      workflowStepRunId?: string | null;
      stepId?: string | null;
    };
  },
): Promise<string | null> {
  if (!input.missionId) return null;
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)))
    .limit(1);
  if (!mission) return null;
  const ownerAgentId = mission.ownerAgentId;

  const [oversightIssue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.originKind, "mission_main_executor_oversight"),
      isNull(issues.hiddenAt),
      not(inArray(issues.status, ["done", "cancelled"])),
    ))
    .orderBy(asc(issues.createdAt))
    .limit(1);
  let wakeIssueId = oversightIssue?.id;
  if (!wakeIssueId) {
    const { missionService } = await import("../missions.js");
    wakeIssueId = (await missionService(db).ensureMainExecutorOversightIssue(mission, mission.title)).id;
  }

  await heartbeatService(db).wakeup(ownerAgentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "owner_action_unblock_handback_report",
    payload: {
      issueId: wakeIssueId,
      missionId: input.missionId,
      unblockIssueId: input.unblockIssueId,
      handbackReportMarker: UNBLOCK_HANDBACK_REPORT_MARKER,
    },
    requestedByActorType: "system",
    requestedByActorId: "owner-action-unblock-handback",
    contextSnapshot: {
      issueId: wakeIssueId,
      missionId: input.missionId,
      source: "owner_action_unblock_handback_report",
      unblockIssueId: input.unblockIssueId,
    },
  });

  // queue evidence: 방금 만든 wakeup row 회수.
  const rows = await db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.issueId, wakeIssueId),
      eq(agentWakeupRequests.agentId, ownerAgentId),
      eq(agentWakeupRequests.reason, "owner_action_unblock_handback_report"),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(8);
  const row = rows.find((candidate) =>
    (candidate.status === "queued" ||
      candidate.status === "claimed" ||
      candidate.status === "deferred_issue_execution" ||
      candidate.status === "coalesced") &&
    candidate.payload?.unblockIssueId === input.unblockIssueId,
  ) ?? null;
  if (!row) return null;

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "owner-action-unblock-handback",
    action: UNBLOCK_HANDBACK_LEDGER_ACTION,
    entityType: "issue",
    entityId: input.unblockIssueId,
    agentId: ownerAgentId,
    details: {
      missionId: input.missionId,
      oversightIssueId: wakeIssueId,
      wakeupRequestId: row.id,
      // Display/audit only — closeout guard never reads this comment.
      reportCommentId: input.reportCommentId,
      sourceIssueId: input.handback.sourceIssueId,
      failureClass: input.handback.failureClass,
      sourceLiveRunWakeState: input.handback.sourceLiveRunWakeState,
      recommendedNativeAction: input.handback.recommendedNativeAction,
      failedRunId: input.handback.failedRunId ?? null,
      workflowRunId: input.handback.workflowRunId ?? null,
      workflowStepRunId: input.handback.workflowStepRunId ?? null,
      stepId: input.handback.stepId ?? null,
    } satisfies UnblockHandbackLedgerDetails,
  });
  return row.id;
}
