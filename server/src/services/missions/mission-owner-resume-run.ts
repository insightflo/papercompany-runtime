// server/src/services/missions/mission-owner-resume-run.ts
//
// [목적] mission_owner_execute 의 resume_run 실행. previewOwnerNativeRunResume 이 종결 결정
//   row 를 직접 읽어 실패 원인 구조(policyCause)를 판별하고, 적격 실패 anchor 는 기존 exact
//   native 복구(stage1: retryIssueLessToolWorkflowStep / stage3: dispatchSourceIssueNativeResume
//   ownerExecution)로 run 을 실제 재개한다. 상태를 running 으로 바꾸기만 하는 것은 재개가 아니다.
//   사람 중지(operator_cancel)·예산 정지(budget_hard_stop)·hard deadline(recovery_deadline_hard)은
//   자동 해제 권한이 없어 사람 판단 대기로 남는다. signed_unexecuted_tail 은 기존 board 전용
//   경계(board_resume_required)를 그대로 돌려줄 뿐 정책 생성·board actor 합성·resumeWorkflowRun
//   board/legacy fallback 은 없다. preview 통과 후에도 native commit/admission 이 owner/권한버전/
//   세대/최신 intent 를 다시 확인한다(계획 Task 4 — old preview 로 실행하지 않는다).
import { and, eq, ne } from "drizzle-orm";
import {
  missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, type Db,
} from "@paperclipai/db";
import type { MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import type { OwnerExecutionContext } from "./mission-owner-execute.js";
import { projectIssueActionResult, recoverDeliveryIfNeeded } from "./mission-owner-execute.js";
import {
  latestIntentEventId, projectOwnerActionResult, recordAppliedEvent, type OwnerActionResult,
} from "./mission-owner-execution-state.js";
import { retryIssueLessToolWorkflowStep } from "../workflow/dag-engine.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { isIssueLessToolStep } from "../workflow/issue-less-tool-shape.js";
import { dispatchSourceIssueNativeResume } from "../workflow/source-issue-native-resume.js";
import { evaluateRecoveryChannels } from "../workflow/run-terminal-recovery-gate.js";
import { isRunRecoveryServiceEnabled } from "../workflow/run-reopen-guard-flag.js";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "../workflow/replacement-execution-safety.js";

export type OwnerRunResumeAction = Extract<MissionOwnerExecuteRequest["action"], { operation: "resume_run" }>;
export type OwnerRunResumePreview = {
  schemaVersion: 1; kind: "eligible" | "blocked"; reasonCode: string | null;
  terminalDecisionId: string; authorityVersion: number; stepRunId: string; executionGeneration: number;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// 오너가 스스로 해제할 수 없는 원인 — 사람/board 판단 대기로 남긴다(계획 Global Constraints 10).
const HUMAN_DECISION_REASONS = new Set(["operator_cancel", "budget_hard_stop",
  "recovery_deadline_hard", "decision_not_failed", "board_resume_required"]);
const requiredActionFor = (reasonCode: string | null, terminalDecisionId: string) =>
  reasonCode && HUMAN_DECISION_REASONS.has(reasonCode)
    ? { kind: "board_resume" as const, targetId: terminalDecisionId, reasonCode } : null;

/** [적격성 preview] 실패 원인 구조 판별. latestTerminalDecision 편의 함수는 policyCause 를 주지
 *  않으므로 종결 row 를 company/run/id 로 직접 읽고 버전 일치를 확인한다. 읽기 전용. */
export async function previewOwnerNativeRunResume(
  context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
): Promise<OwnerRunResumePreview> {
  const action = request.action as OwnerRunResumeAction;
  const target = action.target;
  const blocked = (reasonCode: string): OwnerRunResumePreview => ({ schemaVersion: 1, kind: "blocked",
    reasonCode, terminalDecisionId: action.terminalDecisionId,
    authorityVersion: target.expectedAuthorityVersion, stepRunId: target.stepRunId,
    executionGeneration: target.expectedExecutionGeneration });
  if (action.previewPolicy === "signed_unexecuted_tail") return blocked("board_resume_required");
  const [terminal] = await context.db.select().from(workflowTerminalDecisions).where(and(
    eq(workflowTerminalDecisions.companyId, context.companyId),
    eq(workflowTerminalDecisions.workflowRunId, target.workflowRunId),
    eq(workflowTerminalDecisions.id, action.terminalDecisionId))).limit(1);
  if (!terminal) return blocked("missing_decision");
  if (terminal.decidedAuthorityVersion !== target.expectedAuthorityVersion) return blocked("stale_decision");
  if (terminal.decision !== "failed") return blocked(
    terminal.policyCause === "operator_cancel" ? "operator_cancel" : "decision_not_failed");
  // [허용목록] 자동 재개 자격은 outcome_convergence 뿐이다. 계약 밖·알 수 없는 policyCause 는
  // fail-closed 로 차단한다 — 차단목록 방식은 위조 row 에 fail-open 이 된다.
  if (terminal.policyCause !== "outcome_convergence") return blocked(
    terminal.policyCause === "operator_cancel" ? "operator_cancel"
      : terminal.policyCause === "budget_hard_stop" ? "budget_hard_stop"
      : terminal.policyCause === "recovery_deadline_hard" ? "recovery_deadline_hard"
      : "unsupported_policy_cause");
  const [run] = await context.db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, target.workflowRunId), eq(workflowRuns.companyId, context.companyId))).limit(1);
  if (!run || run.missionId !== request.missionId) return blocked("target_not_found");
  const [replaced] = await context.db.select({ id: workflowRecoveryAuthorities.id })
    .from(workflowRecoveryAuthorities).where(and(
      eq(workflowRecoveryAuthorities.companyId, context.companyId),
      eq(workflowRecoveryAuthorities.workflowRunId, run.id),
      eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"))).limit(1);
  if (replaced) return blocked("replaced_run");
  if (run.status !== "failed") return blocked("run_not_failed");
  if (run.dispatchAuthorityVersion !== target.expectedAuthorityVersion) return blocked("stale_authority_version");
  const [mission] = await context.db.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
    .from(missions).where(and(eq(missions.id, request.missionId),
      eq(missions.companyId, context.companyId))).limit(1);
  if (!mission || mission.status !== "active") return blocked("mission_not_active");
  if (mission.ownerAgentId !== context.agentId) return blocked("not_mission_owner");
  const [stepRun] = await context.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, target.stepRunId), eq(workflowStepRuns.workflowRunId, run.id))).limit(1);
  if (!stepRun || (target.kind === "issue_step" && stepRun.issueId !== target.issueId)) {
    return blocked("target_not_found");
  }
  if (target.kind === "tool_step" && stepRun.issueId) return blocked("target_kind_not_supported");
  if (stepRun.status !== "failed") return blocked("step_not_failed");
  if (stepRun.executionGeneration !== target.expectedExecutionGeneration) return blocked("stale_generation");
  if (stepRun.lastDispatchRequestId !== target.failedDispatchRequestId) return blocked("stale_dispatch");
  if (record(stepRun.metadata).workflowRetryExhaustion) return blocked("retry_exhausted");
  const rows = await context.db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, run.id));
  if (await replacementExecutionInFlight(context.db, context.companyId, run.id, rows)) {
    return blocked("execution_in_flight");
  }
  if (await replacementBudgetBlocked(context.db, context.companyId, mission.ownerAgentId)) {
    return blocked("budget_blocked");
  }
  let anchorStep = null;
  try {
    const steps = (await loadExecutionDefinition(context.db, run.id, { requireHistorical: false })).steps;
    anchorStep = steps.find((step) => step.id === stepRun.stepId) ?? null;
  } catch { return blocked("definition_unavailable"); }
  if (!anchorStep) return blocked("step_not_in_definition");
  if (target.kind === "tool_step" && !isIssueLessToolStep(anchorStep)) {
    return blocked("target_kind_not_supported");
  }
  const byStepId = new Map(rows.map((row) => [row.stepId, row] as const));
  if ((anchorStep.dependencies ?? []).some((dep) => byStepId.get(dep)?.status !== "completed")) {
    return blocked("prerequisites_unmet");
  }
  if (target.kind === "issue_step") {
    if (!await isRunRecoveryServiceEnabled(context.db)) return blocked("recovery_service_disabled");
    const gate = await evaluateRecoveryChannels(context.db, { runId: run.id,
      companyId: context.companyId, missionId: run.missionId, now: new Date(),
      stepRuns: rows.map((row) => ({ id: row.id, stepId: row.stepId, issueId: row.issueId,
        status: row.status, metadata: row.metadata })) });
    if (gate.kind !== "open") return blocked("recovery_gate_closed");
  }
  return { schemaVersion: 1, kind: "eligible", reasonCode: null,
    terminalDecisionId: action.terminalDecisionId, authorityVersion: run.dispatchAuthorityVersion,
    stepRunId: stepRun.id, executionGeneration: stepRun.executionGeneration };
}

/** [anchor 범위] anchor 가 실제 완료돼도 다른 실패 branch 가 남으면 run 전체 resolved 를 선언하지
 *  않는다. 남은 실패 step 을 evidence marker(kind heartbeat, recordId "")로 결과에 표시한다 —
 *  표시 전용이며 heartbeat 권위 주장이 아니다(결과 계약은 execution-state 소유). */
export async function finalizeOwnerResumeProjection(db: Db, companyId: string, workflowRunId: string,
  anchorStepRunId: string, projected: OwnerActionResult): Promise<OwnerActionResult> {
  const base = { ...projected, operation: "resume_run" as const };
  if (projected.state !== "resolved") return base;
  const remaining = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.companyId, companyId), eq(workflowStepRuns.workflowRunId, workflowRunId),
      eq(workflowStepRuns.status, "failed"), ne(workflowStepRuns.id, anchorStepRunId))).limit(3);
  if (remaining.length === 0) return base;
  return { ...base, state: "blocked", reasonCode: "failed_steps_remain",
    evidence: [...projected.evidence, ...remaining.map((row) => ({ kind: "heartbeat" as const,
      recordId: "", workflowRunId, stepRunId: row.id, executionGeneration: null, requestId: null }))] };
}

/** [실행] preview 적격 anchor 를 기존 exact native 복구로 실제 재개한다. tool anchor 는 stage1
 *  경로, issue anchor 는 stage3 ownerExecution 경로 — exact failure CAS·intent fence·authority
 *  연결(v+1 소비, 새 세대)을 native 가 그대로 소유한다. 전달(delivery)과 실제 완료는 결과 투영이
 *  구분한다. 적격이어도 native 거부 시 부작용 0 + 최신 구조 사유로 blocked. */
export async function executeOwnerRunResume(context: OwnerExecutionContext,
  request: MissionOwnerExecuteRequest, actionId: string): Promise<OwnerActionResult> {
  const action = request.action as OwnerRunResumeAction;
  const target = action.target;
  const evidence = [{ kind: "heartbeat" as const, recordId: actionId,
    workflowRunId: target.workflowRunId, stepRunId: target.stepRunId,
    executionGeneration: target.expectedExecutionGeneration, requestId: null }];
  const blockedResult = (reasonCode: string | null): OwnerActionResult => ({ schemaVersion: 1, actionId,
    operation: "resume_run", state: "blocked", reasonCode, evidence,
    requiredAction: requiredActionFor(reasonCode, action.terminalDecisionId) });
  const preview = await previewOwnerNativeRunResume(context, request);
  if (preview.kind === "blocked") return blockedResult(preview.reasonCode);
  const validateIntent = async (tx: Db): Promise<boolean> => {
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
      .from(missions).where(and(eq(missions.id, request.missionId),
        eq(missions.companyId, context.companyId))).limit(1);
    if (!mission || mission.status !== "active" || mission.ownerAgentId !== context.agentId) return false;
    return await latestIntentEventId(tx, context.companyId, request.ownerActionIssueId) === actionId;
  };
  const [persistedStep] = await context.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, target.stepRunId), eq(workflowStepRuns.workflowRunId, target.workflowRunId))).limit(1);
  if (!persistedStep) return blockedResult("target_not_found");
  const issueDispatched = target.kind === "issue_step"
    ? (await dispatchSourceIssueNativeResume(context.db, { companyId: context.companyId,
        issueId: target.issueId, agentId: context.agentId, allowBlockedIssue: true,
        ownerExecution: { actionId, missionId: request.missionId, workflowRunId: target.workflowRunId,
          stepRunId: target.stepRunId, expectedAuthorityVersion: target.expectedAuthorityVersion,
          expectedExecutionGeneration: target.expectedExecutionGeneration,
          failedDispatchRequestId: target.failedDispatchRequestId, validateIntent } })).kind === "dispatched"
    : null;
  const toolNative = issueDispatched === null
    ? await retryIssueLessToolWorkflowStep(context.db, { companyId: context.companyId,
        runId: target.workflowRunId, stepId: persistedStep.stepId,
        recoveryRequestReference: `mission-owner-execute:${actionId}`,
        expectedFailure: { stepRunId: target.stepRunId, authorityVersion: target.expectedAuthorityVersion,
          executionGeneration: target.expectedExecutionGeneration,
          dispatchRequestId: target.failedDispatchRequestId }, validateIntent })
    : null;
  const [authority] = await context.db.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, context.companyId),
    eq(workflowRecoveryAuthorities.workflowRunId, target.workflowRunId),
    eq(workflowRecoveryAuthorities.recoveryKind, "supervision_tool_retry"),
    eq(workflowRecoveryAuthorities.requestReference, `mission-owner-execute:${actionId}`),
    eq(workflowRecoveryAuthorities.targetAuthorityVersion, target.expectedAuthorityVersion))).limit(1);
  if ((issueDispatched === false || (issueDispatched === null && !toolNative)) && !authority) {
    const fresh = await previewOwnerNativeRunResume(context, request);
    return blockedResult(fresh.kind === "blocked" ? fresh.reasonCode : "recovery_rejected");
  }
  // native authority 소비(또는 crash 로 applied-미기록) 확인 — 1회 기록, 전달만 회복.
  const [after] = await context.db.select({ stepRun: workflowStepRuns, run: workflowRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(eq(workflowStepRuns.id, target.stepRunId)).limit(1);
  await recordAppliedEvent(context.db, context.companyId, { actionId, operation: "resume_run",
    missionId: request.missionId, workflowRunId: target.workflowRunId, stepRunId: target.stepRunId,
    authorityId: authority?.id ?? null, authorityVersion: after?.run.dispatchAuthorityVersion ?? null,
    executionGeneration: after?.stepRun.executionGeneration ?? null,
    dispatchRequestId: after?.stepRun.lastDispatchRequestId ?? null });
  await recoverDeliveryIfNeeded(context, request, actionId, validateIntent);
  const projected = target.kind === "issue_step"
    ? await projectIssueActionResult(context.db, context.companyId, request.missionId, actionId, target.issueId)
    : await projectOwnerActionResult(context.db, context.companyId, request.missionId, actionId, "resume_run");
  return finalizeOwnerResumeProjection(context.db, context.companyId,
    target.workflowRunId, target.stepRunId, projected);
}
