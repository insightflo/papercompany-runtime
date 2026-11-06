import { agentWakeupRequests, issueWorkProducts, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { formatMissionPlanConsumerDiagnostics } from "./mission-plan-consumer-diagnostics.js";
import { isTerminalIssueStatus, SOURCE_RETRY_WORK_PRODUCT_MAX, type SourceRetryWorkProduct } from "./mission-owner-recovery-comments.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import { isQaLikeStep, type DagStepLike } from "./supervision-helpers.js";
import type { MissionOwnerSupervisionAppliedAction } from "./supervision-types.js";
import { issueLessToolRecoveryOwnsFailure } from "./tool-step-recovery-authority.js";

// [issue-less tool recovery card liveness] 실패한 이슈 없는 도구 단계의 복구 권한은 링크된
// owner_tool_recovery_target_v1 카드에 있다. 카드가 열려 있거나 아직 없으면(첫 감시 패스에서
// 생성 예정) 억제를 유지한다. 모든 링크 카드가 종료(done/cancelled)면 복구 권한은 소진된
// 것이므로 터미널 Human Operator 보고 경로로 넘어간다(2026-10-14 a6d16f90 사고).
export async function hasOpenOrMissingIssueLessToolRecoveryCard(db: Db, input: {
  companyId: string; missionId: string; workflowStepRows: MissionSupervisionWorkflowStepRow[];
}): Promise<boolean> {
  const stepRunIds = input.workflowStepRows
    .filter((row) => issueLessToolRecoveryOwnsFailure(row))
    .map((row) => row.stepRun.id);
  if (stepRunIds.length === 0) return false;
  const linked = await db
    .select({ workflowStepRunId: workflowTransitionEvents.workflowStepRunId, status: issues.status })
    .from(workflowTransitionEvents)
    .innerJoin(issues, eq(issues.id, workflowTransitionEvents.issueId))
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.missionId, input.missionId),
      eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"),
      inArray(workflowTransitionEvents.workflowStepRunId, stepRunIds),
    ));
  const statusesByStepRunId = new Map<string, string[]>();
  for (const row of linked) {
    if (!row.workflowStepRunId) continue;
    const list = statusesByStepRunId.get(row.workflowStepRunId) ?? [];
    list.push(row.status);
    statusesByStepRunId.set(row.workflowStepRunId, list);
  }
  return stepRunIds.some((stepRunId) => {
    const statuses = statusesByStepRunId.get(stepRunId) ?? [];
    if (statuses.length === 0) return true;
    return statuses.some((status) => !isTerminalIssueStatus(status));
  });
}

/** [observability] wakeup callback 결과(report_only 등)에서 fail-closed 사유 문자열만 안전 추출. */
export function readWakeupResultDetailReason(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}
export function formatAppliedAction(action: MissionOwnerSupervisionAppliedAction): string {
  switch (action.type) {
    case "dispatch_missing_step":
      return `- ${action.type}: run=${action.workflowRunId} steps=${action.stepIds.join(",") || "n/a"} result=${action.resultStatus}`;
    case "owner_decision_retry_source_issue":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} source=${action.sourceIssueId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus ?? "n/a"}`;
    case "owner_decision_retry_unresolved":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} retry_target=${action.sourceIssueId} blocked=${action.blockedIssueId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus ?? "n/a"}`;
    case "owner_decision_reassign_source_issue":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} source=${action.sourceIssueId} previous=${action.previousAgentId ?? "unassigned"} target=${action.targetAgentId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus ?? "n/a"}`;
    case "owner_decision_replan_mission":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} planning_issue=${action.planningIssueId} result=${action.resultStatus}`;
    case "native_tool_step_retry":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} run=${action.workflowRunId} step=${action.stepId} step_run=${action.stepRunId} result=${action.resultStatus}`;
    case "native_tool_step_recovery_result":
      return `- ${action.type}: owner_action=${action.ownerActionIssueId} run=${action.workflowRunId} step=${action.stepId} step_run=${action.stepRunId} artifact=${action.artifactPath} result=${action.resultStatus}`;
    case "materialize_plan_decision":
      return `- ${action.type}: planning_issue=${action.planningIssueId ?? "n/a"} workflow_run=${action.workflowRunId ?? "n/a"} result=${action.resultStatus}${formatMissionPlanConsumerDiagnostics(action)}`;
    case "workproduct_reuse_wakeup":
      return `- ${action.type}: source=${action.sourceIssueId} artifact=${action.artifactPath} stalled_run=${action.stalledRunId} result=${action.resultStatus}`;
    case "plan_submission_missing":
      return `- ${action.type}: planning_issue=${action.planIssueId} succeeded_run=${action.succeededRunId} result=${action.resultStatus}`;
    case "plan_submission_rejected":
      return `- ${action.type}: planning_issue=${action.planIssueId} decision_hash=${action.decisionHash} result=${action.resultStatus}`;
    case "stale_source_issue_wakeup":
      return `- ${action.type}: source=${action.sourceIssueId} failed_run=${action.failedRunId} result=${action.resultStatus} wakeup=${action.wakeupDispatchStatus}`;
    case "mission_settled_from_workflow_runs":
      return `- ${action.type}: mission=${action.missionId} result=${action.resultStatus}`;
  }
}

export function isPlanSubmissionRecoveryIssueStatus(status: string): boolean {
  return status === "blocked" || isTerminalIssueStatus(status);
}

export const REJECTED_PLAN_RECOVERY_PROMPT_REVISION = "v2";

// [P3] originId 가 실제 workflow QA gate step 이면 그 id, 아니면 null. QA chain 오인 방지(codex 정정 1).
export function resolveQaGateIssueId(input: {
  originId: string | null;
  missionIssueById: Map<string, MissionSupervisionIssue>;
  stepRowsByIssueId: Map<string, MissionSupervisionWorkflowStepRow[]>;
}): string | null {
  if (!input.originId) return null;
  const originIssue = input.missionIssueById.get(input.originId);
  if (!originIssue || originIssue.originKind !== "workflow_execution") return null;
  const stepRows = input.stepRowsByIssueId.get(input.originId) ?? [];
  const stepRow = stepRows[0];
  if (!stepRow) return null;
  const stepId = stepRow.stepRun.stepId ?? "";
  const steps = stepRow.definition.stepsJson as DagStepLike[] | null;
  const step = Array.isArray(steps) ? steps.find((s) => (s as { id?: string }).id === stepId) : null;
  // supervision-helpers 의 isQaLikeStep 사용(QA 이름/title/한국어 검수/validate/audit/qaType 포괄, codex 보완 1).
  if (step && isQaLikeStep(step as Parameters<typeof isQaLikeStep>[0])) return input.originId;
  return null;
}

// [P3] source 의 active workProduct updatedAt(current-generation 기준, codex 정정 4).
export async function loadActiveWorkProductUpdatedAt(db: Db, companyId: string, issueId: string): Promise<Date | null> {
  const row = await db.select({ updatedAt: issueWorkProducts.updatedAt })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.issueId, issueId),
      eq(issueWorkProducts.status, "active"),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.updatedAt ?? null;
}
export async function hasRecoveryIdempotency(db: Db, companyId: string, idempotencyKey: string): Promise<boolean> {
  const [event, wakeup] = await Promise.all([
    db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
    )).limit(1).then((rows) => rows[0] ?? null),
    db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return Boolean(event || wakeup);
}

/**
 * [half-applied owner decision] wakeup 멱등은 "실제로 발사된" 증거만 만족한다.
 *   mission_owner_retry_wakeup 마커가 not_requested/failed/skipped_no_assignee 로 기록된 경우는
 *   아무것도 발사되지 않은 것이므로 '이미 적용됨'으로 간주하지 않는다(2026-08-15 GAZ ef12d027
 *   30시간 stall: not_requested 마커가 영구 멱급 게이트가 됐다). 실제 agent_wakeup_requests 행은
 *   항상 발사 증거로 인정한다.
 */
export const DISPATCHED_RECOVERY_WAKEUP_STATUSES = new Set(["dispatched", "workflow_already_dispatched"]);

export async function hasDispatchedRecoveryWakeup(db: Db, companyId: string, idempotencyKey: string): Promise<boolean> {
  const [event, wakeup] = await Promise.all([
    db.select({ toStatus: workflowTransitionEvents.toStatus }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
      inArray(workflowTransitionEvents.toStatus, [...DISPATCHED_RECOVERY_WAKEUP_STATUSES]),
    )).limit(1).then((rows) => rows[0] ?? null),
    db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return Boolean(event || wakeup);
}

export async function recordRecoveryAction(input: {
  readonly db: Db; readonly companyId: string; readonly missionId: string; readonly issueId: string;
  readonly idempotencyKey: string; readonly eventType: string; readonly decision: string; readonly resultStatus: string;
  readonly sourceIssueId?: string; readonly workflowRunId?: string; readonly workflowStepRunId?: string; readonly stepId?: string;
}): Promise<void> {
  await input.db.insert(workflowTransitionEvents).values({
    companyId: input.companyId, missionId: input.missionId, issueId: input.issueId,
    workflowRunId: input.workflowRunId ?? null, workflowStepRunId: input.workflowStepRunId ?? null,
    eventType: input.eventType, layer: "mission_owner_recovery", decision: input.decision,
    fromStatus: input.eventType === "mission_owner_tool_step_retry" ? "failed" : null,
    toStatus: input.resultStatus, reason: "owner_recovery_api", reasonCode: "owner_recovery_api",
    idempotencyKey: input.idempotencyKey,
    payload: {
      kind: input.eventType, ownerActionIssueId: input.issueId, resultStatus: input.resultStatus,
      ...(input.sourceIssueId ? { sourceIssueId: input.sourceIssueId } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepRunId ? { workflowStepRunId: input.workflowStepRunId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
    },
  }).onConflictDoNothing();
  // [half-applied owner decision] 같은 key 마커가 이미 있으면(예: not_requested) 결과 상태를 갱신한다.
  //   doNothing 만으로는 발사 실패 마커가 영구 남아 재발사 수렴을 막는다(2026-08-15 GAZ ef12d027).
  if (input.idempotencyKey) {
    await input.db
      .update(workflowTransitionEvents)
      .set({ toStatus: input.resultStatus })
      .where(and(
        eq(workflowTransitionEvents.companyId, input.companyId),
        eq(workflowTransitionEvents.idempotencyKey, input.idempotencyKey),
      ));
  }
}

/**
 * [supervision once-only claim] 감독 스윕이 "최초 1회"만 의미 있는 부수 효과(오너 재깨움 등)를 켤 때
 *   쓰는 멱등 클레임. 첫 insert 가 이기면 true, 이후 스윕은 false. append-only(삭제 없음).
 */
export async function claimSupervisionMarkerOnce(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly missionId: string;
  readonly issueId: string | null;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await input.db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    missionId: input.missionId,
    issueId: input.issueId,
    eventType: input.eventType,
    layer: "mission_owner_recovery",
    idempotencyKey: input.idempotencyKey,
    payload: { kind: input.eventType, ...input.payload },
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  return rows.length > 0;
}

/** [terminal-run closeout] 실행 단위의 종단 상태(이 상태에서 mission 이 아직 active 면 종결 브리지 대상). */
export const TERMINAL_CLOSEOUT_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** [owner on-duty monitoring] 오너 주기 리뷰 대상 실행 상태 — 진행 중이거나 미결(실패류)인 단위. */
export const ACTIVE_SUPERVISION_EXECUTION_STATUSES_FOR_REVIEW = new Set(["pending", "running", "failed", "cancelled", "timed_out"]);

/**
 * [escalate-suppressed watchdog] 최근(24h) 오너의 사람 상정(escalate/request_input) 결정이 존재하는지.
 *   억제(live-wakeup 계열)가 지속되는 동안 사람 통지가 실제로 전달됐는지 의심해야 하는 근거.
 */
export async function hasRecentHumanEscalationDecision(db: Db, companyId: string, missionId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db.select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.missionId, missionId),
      eq(workflowTransitionEvents.layer, "mission_owner_recovery"),
      inArray(workflowTransitionEvents.decision, ["escalate", "request_input"]),
      gte(workflowTransitionEvents.createdAt, since),
    ))
    .limit(1);
  return Boolean(row);
}
// [final QA / mission validation owner recovery] retry 가 깨울 source issue 의 active workProduct 를
//   company+mission+source-issue scope 로 명시적으로 읽는다(issueWorkProducts.companyId + issueId 와
//   issues.companyId + id + missionId 를 모두 검증). capped mission digest 에 의존하지 않고 원본 source
//   issue title+description + active products(url/externalId/metadata path) + latest REQUEST_CHANGES feedback
//   를 묶어 전달. 카운트는 bound.
export async function loadActiveSourceIssueWorkProducts(
  db: Db,
  companyId: string,
  missionId: string,
  issueId: string,
): Promise<SourceRetryWorkProduct[]> {
  const rows = await db.select({
    title: issueWorkProducts.title,
    type: issueWorkProducts.type,
    provider: issueWorkProducts.provider,
    url: issueWorkProducts.url,
    externalId: issueWorkProducts.externalId,
    metadata: issueWorkProducts.metadata,
  })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.issueId, issueId),
      eq(issueWorkProducts.status, "active"),
      eq(issues.companyId, companyId),
      eq(issues.id, issueId),
      eq(issues.missionId, missionId),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt))
    .limit(SOURCE_RETRY_WORK_PRODUCT_MAX);
  return rows.map((row) => ({
    title: row.title,
    type: row.type,
    provider: row.provider,
    url: row.url ?? null,
    externalId: row.externalId ?? null,
    metadata: row.metadata ?? null,
  }));
}
