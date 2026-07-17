// server/src/services/missions/owner-action-unblock-handback.ts
//
// [파일 목적] mission_main_executor_unblock 완료 시 source(originId) 를 직접 checkout/재시도 하지
//   않기 위한 evidence + native 분류 + 구조화 report (생성/파싱) 헬퍼. 실제 wake 은
//   services/workflow/source-issue-native-resume.ts 의 검증된 DAG 헬퍼가 담당한다. 이 모듈은
//   (a) source 상태/step run/failed run/live run+wake + timed_out/error/exit 신호를 모아
//   evidence 를 만들고, (b) native outcome 으로 failureClass·recommendedNativeAction 를 분류하며,
//   (c) Oversight 가 읽을 수 있는 구조화 report comment 를 빌드/파싱한다.
// [주요 흐름]
//   gatherUnblockSourceEvidence → facts. deriveUnblockDispatchClassification(evidence, outcome) →
//   failureClass/recommendedNativeAction. buildUnblockHandbackReportComment → 마커 기반 구조화 report.
//   parseUnblockHandbackReport → done closeout guard 가 report 를 "마커만" 통과시키지 않도록 검증.
// [계약] recovery 는 오직 검증된 native workflow_resume 경로 또는 report-only. 새 endpoint · direct
//   source checkout · source status 강제 변경 · 범용 retry framework 없음. 공식 retry/iteration/QA
//   verdict 는 workflow layer 소유. report 마커 자체가 closeout evidence 가 아니라 — sourceIssueId
//   일치 + 필수 필수필드 전부 갖춘 구조화 report 만이 evidence 이다.
// [수정시 영향] LIVE_*_STATUSES / FAILED_RUN_STATUSES / failureClass 분기가 바뀌면 done guard 와
//   Phase D stopped-execution 판정이 정렬되어야 한다(같은 live 상태 집합 사용).
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, not, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
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

// report comment 첫 줄 마커 — done closeout guard 가 report 후보를 인식하는 계약. 마커 단독은
//   closeout 을 충족하지 않으며 parseUnblockHandbackReport 의 전체 필드 검증을 통과해야 한다.
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

// [목적] done closeout guard 가 "마커만" 있는 임의 comment 로 closeout 되는 것을 막기 위해
//   구조화 report 를 파싱/검증한다. 필수 필드 전부 + sourceIssueId 일치 + 알려진 enum 값이어야 인정.
// [입력] body(comment 본문), expectedSourceIssueId(guard 의 originId).
// [출력] valid 여부. 마커가 없거나 필수 필드 누락/외국값/source 불일치면 false.
export function parseUnblockHandbackReport(
  body: string,
  expectedSourceIssueId: string,
): boolean {
  if (typeof body !== "string" || !body.startsWith(UNBLOCK_HANDBACK_REPORT_MARKER)) return false;
  const fields = new Map<string, string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === UNBLOCK_HANDBACK_REPORT_MARKER || line === "evidence:") continue;
    const match = /^-?\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    // 동일 키가 여러 번 나오면 첫 값을 쓴다(evidence block 의 키와 충돌 않게 — 이름이 다름).
    if (!fields.has(key)) fields.set(key, value.trim());
  }
  const required = [
    "sourceIssueId",
    "failedRunId",
    "failureClass",
    "sourceLiveRunWakeState",
    "recommendedNativeAction",
  ];
  for (const key of required) {
    if (!fields.has(key)) return false;
  }
  if (fields.get("sourceIssueId") !== expectedSourceIssueId) return false;
  if (!UNBLOCK_FAILURE_CLASSES.has(fields.get("failureClass") ?? "")) return false;
  if (!UNBLOCK_RECOMMENDED_NATIVE_ACTIONS.has(fields.get("recommendedNativeAction") ?? "")) return false;
  // sourceLiveRunWakeState 는 값이 있기만 하면 되지만 과도하게 느슨한 값을 피해 enum 으로 제한.
  const liveState = fields.get("sourceLiveRunWakeState");
  if (liveState !== "live" && liveState !== "none") return false;
  // evidence block 이 구조적으로 존재하는지 확인한다 — substring("evidence:") 검사는 다른 필드
  //   값 안에 "evidence:" 가 끼어든 comment 로 우회될 수 있다. 따라서 "evidence:" 단독 헤더 라인
  //   뒤에 최소 하나 이상의 "- key: value" 항목이 있어야 구조화 report 로 인정한다.
  const lines = body.split("\n");
  const evidenceStart = lines.findIndex((l) => l.trim() === "evidence:");
  if (evidenceStart === -1) return false;
  const hasEvidenceItem = lines.slice(evidenceStart + 1).some((l) => /^\s*-\s+[A-Za-z][A-Za-z0-9_]*\s*:/.test(l));
  if (!hasEvidenceItem) return false;
  return true;
}

// done closeout guard 진입점: unblock 이슈의 comment 중 "검증 통과한" report 가 하나라도 있는지.
//   expectedSourceIssueId 는 guard 의 originId(source) 여야 한다(외국 source 마커 거부).
export async function unblockIssueHasValidatedHandbackReport(
  db: Db,
  input: { companyId: string; unblockIssueId: string; expectedSourceIssueId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.unblockIssueId),
    ));
  const validReportCommentIds = new Set(
    rows
      .filter((row) => typeof row.body === "string" && parseUnblockHandbackReport(row.body, input.expectedSourceIssueId))
      .map((row) => row.id),
  );
  if (validReportCommentIds.size === 0) return false;

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
  return ledgers.some((ledger) => {
    const reportCommentId = ledger.details && typeof ledger.details.reportCommentId === "string"
      ? ledger.details.reportCommentId
      : null;
    return reportCommentId !== null && validReportCommentIds.has(reportCommentId);
  });
}

// [목적] report-only 경로에서 구조화 report 를 쓴 직후, 기존 Oversight owner work item(mission
//   의 mission_main_executor_oversight issue)을 일반 실행 큐(heartbeat.wakeup → agent_wakeup_requests)
//   로 즉시 깨운다. 다음 supervision timer 까지 기다리지 않고 owner 가 report 를 바로 보게 한다.
//   source assignee 가 없어도 동작한다(owner 를 깨운다). queue evidence(wakeup id) 를 반환.
// [계약] forbidden retry reason(mission_owner_*_retry_source_issue) 사용 금지 — 이건 generic
//   oversight handback wake 다. source status / checkout 변경 없음.
export async function handUnblockReportToOversightOwner(
  db: Db,
  input: { companyId: string; missionId: string | null; unblockIssueId: string; reportCommentId: string },
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
      reportCommentId: input.reportCommentId,
    },
  });
  return row.id;
}
