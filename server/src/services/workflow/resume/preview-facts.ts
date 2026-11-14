import type {
  companies,
  issueWorkProducts,
  toolDefinitions,
  workflowResumeExecutions,
  workflowResumeRequests,
} from "@paperclipai/db";
import { checkRecordedHeartbeatSettlements, type RecordedSettlementBlocker } from "./recorded-settlement.js";
import { checkObservedResourceConflicts, type ObservedResourceBlocker } from "./observed-resource-conflicts.js";
import { checkObservedWakeupConflicts, type ObservedWakeupBlocker } from "./observed-wakeup-conflicts.js";
import { hashStructuredValue } from "../../issue-execution-cards/hash.js";
import { approvalRequiredStepIds } from "./preview-policy.js";
import type { ReviewedResumePolicy } from "./reviewed-policy.js";
import type { SnapshotState } from "./snapshot-state.js";
import type { ResumeExecutionHistoryScope } from "./read-model.js";
import type { ResumeWorkspaceMissionHistory } from "./read-model-workspaces.js";
import type { StepHistory } from "./types.js";

/**
 * [파일 목적] Task6a preview 정책 팩트 수집기 — whole-mission raw 행 위에서 활성 작업/예산/step
 *   이력 팩트 확정, 기존 checker 3종 결과를 그대로 blocker 로 변환, SnapshotState/factsHash 조립.
 * [명시적 한계 — 빈 blocker 는 적격이 아니다] delegation 은 status allowlist 를 발명하지 않고 행
 *   존재 자체를 잠정 active_work 로 본다(상위가 전환 소스를 좁히기 전까지의 conservative proof
 *   gap — settled 아님). toolQueue 는 미종료 스텝에서만 own property + nonnull 로 활성 판정하고 종료 스텝의 예약 기록은 과거 흔적로 본다(2026-10-22 liveness 교정). checker
 *   빈 결과는 "그 검사 통과" 하나일 뿐이다. resumeEpoch malformed 은 missing(0) 과 달리
 *   unsupported_status 로 거부한다.
 */

export type ResumePreviewBlocker = { code: string; message: string; detail?: Record<string, unknown> };

export type ResumeRequestRow = typeof workflowResumeRequests.$inferSelect;
export type ResumeExecutionRow = typeof workflowResumeExecutions.$inferSelect;
type StepRow = ResumeWorkspaceMissionHistory["missionSteps"][number];

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_EXECUTION_STATES: ReadonlySet<string> = new Set(["queued", "running"]);

/** [liveness 교정 2026-10-22] 잔여 흔적 판정용 종료 상태 어휘 — 스텝/하트비트/웨이크업.
 *   review-relief 완화 판정도 동일 어휘를 쓴다(단일 원본 — 복제 금지). */
export const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "skipped"]);
export const TERMINAL_HEARTBEAT_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export const TERMINAL_WAKEUP_STATUSES: ReadonlySet<string> = new Set(["coalesced", "skipped", "completed", "failed", "cancelled", "timed_out"]);

/** [stuck 판정 임계] running 스텝의 마지막 durable 활동(종말 하트비트) 이후 이 시간이
 *   지나면 "stuck" 후보로 본다. 디스패치/재시도는 분 단위로 진행되므로 30분 무진행은
 *   살아있는 실행으로는 설명되지 않는다. */
export const STUCK_INACTIVITY_THRESHOLD_MINUTES = 30;

/**
 * [stuck 판정] status==="running" 인 스텝이 "살아있는 실행 없이 임계 무활동" 인지 판정한다.
 *   fail-closed: 바인딩된 하트비트가 하나도 없거나(디스패치 증거 부재), 바인딩/오너 참조 중
 *   하나라도 비종말이거나, 참조 행이 수집 집합에서 누락돼 종말을 증명할 수 없으면 false.
 *   시간 비교는 마지막 종말 하트비트의 finishedAt(없으면 updatedAt) 대 now 이다.
 */
export function isStepRunStuck(
  row: {
    id: string;
    status: string;
    dispatchOwnerWakeupRequestId: string | null;
    dispatchOwnerHeartbeatRunId: string | null;
  },
  history: ResumeWorkspaceMissionHistory,
  opts: { now: Date; thresholdMinutes?: number },
): boolean {
  if (row.status !== "running") return false;
  const wakeupStatusById = new Map(history.history.wakeups.map((wake) => [wake.id, wake.status]));
  const heartbeatStatusById = new Map(history.history.heartbeats.map((hb) => [hb.id, hb.status]));
  const wakeupDead = (id: string | null): boolean =>
    id === null || (wakeupStatusById.has(id) && TERMINAL_WAKEUP_STATUSES.has(wakeupStatusById.get(id)!));
  const heartbeatDead = (id: string | null): boolean =>
    id === null || (heartbeatStatusById.has(id) && TERMINAL_HEARTBEAT_STATUSES.has(heartbeatStatusById.get(id)!));
  // 오너 참조가 가리키는 행이 수집 집합에 없으면 종말 증명 불가 → stuck 아님(fail-closed).
  if (!wakeupDead(row.dispatchOwnerWakeupRequestId) || !heartbeatDead(row.dispatchOwnerHeartbeatRunId)) {
    return false;
  }
  const boundHeartbeats = history.history.heartbeats.filter((hb) => hb.workflowStepRunId === row.id);
  if (boundHeartbeats.length === 0) return false;
  if (boundHeartbeats.some((hb) => !TERMINAL_HEARTBEAT_STATUSES.has(hb.status))) return false;
  const boundWakeupLive = history.history.wakeups.some(
    (wake) => wake.workflowStepRunId === row.id && !TERMINAL_WAKEUP_STATUSES.has(wake.status),
  );
  if (boundWakeupLive) return false;
  const lastActivityMs = Math.max(
    ...boundHeartbeats.map((hb) => (hb.finishedAt ?? hb.updatedAt)?.getTime() ?? 0),
  );
  if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) return false;
  const thresholdMs = (opts.thresholdMinutes ?? STUCK_INACTIVITY_THRESHOLD_MINUTES) * 60_000;
  return opts.now.getTime() - lastActivityMs > thresholdMs;
}

/** checker reason → 사람 판독용 한국어 메시지(실행 권위 아님 — code 가 권위다). */
const CHECKER_MESSAGES: Readonly<Record<string, string>> = {
  settlement_scope_mismatch: "하트비트 정산 레코드가 스코프와 일치하지 않습니다",
  heartbeat_not_terminal: "하트비트 실행이 아직 종료 상태가 아닙니다",
  settlement_unproven: "하트비트 내구 정산이 기록에서 증명되지 않았습니다",
  finalization_identity_unproven: "정산 부모 레코드가 실행 신원에 정확히 결속되지 않았습니다",
  finalization_stages_unproven: "정산 단계 기록이 요구 상태를 충족하지 않았습니다",
  resource_scope_mismatch: "자원 레코드가 스코프와 일치하지 않습니다",
  resource_identity_ambiguous: "자원 레코드 식별자가 모호합니다",
  resource_lineage_unproven: "자원 레코드의 계보 참조가 증명되지 않았습니다",
  resource_not_terminal: "자원 연산이 아직 종료 상태가 아닙니다",
  resource_owner_present: "자원에 아직 활성 소유자가 남아 있습니다",
  resource_terminal_record_unproven: "자원 종료 기록이 증명되지 않았습니다",
  wakeup_scope_mismatch: "웨이크업 레코드가 스코프와 일치하지 않습니다",
  wakeup_identity_ambiguous: "웨이크업 레코드 식별자가 모호합니다",
  wakeup_link_unproven: "웨이크업 링크 참조가 증명되지 않았습니다",
  wakeup_not_terminal: "웨이크업 요청이 아직 종료 상태가 아닙니다",
  wakeup_linked_heartbeat_not_terminal: "웨이크업에 연결된 하트비트가 종료 상태가 아닙니다",
  wakeup_terminal_record_unproven: "웨이크업 종료 기록이 증명되지 않았습니다",
};

export function checkerBlockers(
  blockers: (RecordedSettlementBlocker | ObservedResourceBlocker | ObservedWakeupBlocker)[],
): ResumePreviewBlocker[] {
  return blockers.map((blocker) => ({
    code: blocker.code,
    message: CHECKER_MESSAGES[blocker.reason] ?? "기록된 실행 정리 검사가 통과하지 못했습니다",
    detail: { reason: blocker.reason, resourceId: "resourceId" in blocker ? blocker.resourceId : blocker.heartbeatRunId },
  }));
}

/** 기존 checker 3종을 whole-mission 행 위에 그대로 실행한다(변경 없음). */
export function recordedCheckerBlockers(history: ResumeWorkspaceMissionHistory): ResumePreviewBlocker[] {
  const scope: ResumeExecutionHistoryScope = history.selected.scope;
  return [
    ...checkerBlockers(checkRecordedHeartbeatSettlements({
      scope,
      heartbeats: history.history.heartbeats,
      finalizations: history.resources.finalizations,
      finalizationSteps: history.resources.finalizationSteps,
    })),
    ...checkerBlockers(checkObservedResourceConflicts({
      scope,
      issues: history.history.issues,
      heartbeats: history.history.heartbeats,
      workspaceOperations: history.resources.workspaceOperations,
      workspaceRuntimeServices: history.resources.workspaceRuntimeServices,
      missionAgentRuntimes: history.resources.missionAgentRuntimes,
    })),
    ...checkerBlockers(checkObservedWakeupConflicts({
      scope,
      wakeups: history.history.wakeups,
      heartbeats: history.history.heartbeats,
    })),
  ];
}

function activeWork(message: string, detail: Record<string, unknown>): ResumePreviewBlocker {
  return { code: "active_work", message, detail };
}

/** 계약 1·7 — run/mission status, whole-mission 잔존 작업, delegation 보수 차단, 요청/실행.
 *   stuckStepRunIds 는 호출자가 isStepRunStuck 로 확정한 집합 — run 이 stuck 스텝만으로
 *   "살아있는" 상태일 때 비종말 run 차단과 running 스텝 차단을 bypass 한다. */
export function wholeMissionBlockers(
  history: ResumeWorkspaceMissionHistory,
  requests: ResumeRequestRow[],
  executions: ResumeExecutionRow[],
  stuckStepRunIds?: ReadonlySet<string>,
): ResumePreviewBlocker[] {
  const blockers: ResumePreviewBlocker[] = [];
  const selected = history.selected;
  const runningSteps = history.missionSteps.filter((step) => step.status === "running");
  const onlyStuckExecution = (stuckStepRunIds?.size ?? 0) > 0
    && runningSteps.length > 0
    && runningSteps.every((step) => stuckStepRunIds!.has(step.id));
  if (!TERMINAL_RUN_STATUSES.has(selected.run.status) && !onlyStuckExecution) {
    blockers.push({
      code: "unsupported_status",
      message: "선택된 워크플로 런이 재개 가능한 종료 상태가 아닙니다",
      detail: { workflowRunId: selected.run.id },
    });
  }
  if (selected.mission.status !== "completed" && selected.mission.status !== "active") {
    blockers.push({
      code: "unsupported_status",
      message: "미션 상태가 재개 검토 대상이 아닙니다",
      detail: { missionId: selected.mission.id },
    });
  }
  for (const run of history.missionRuns) {
    if (run.id !== selected.run.id && !TERMINAL_RUN_STATUSES.has(run.status)) {
      blockers.push(activeWork("같은 미션의 다른 워크플로 런이 아직 종료되지 않았습니다", { workflowRunId: run.id }));
    }
  }
  for (const step of history.missionSteps) {
    if (step.status === "running" && !stuckStepRunIds?.has(step.id)) {
      blockers.push(activeWork("미션 전체에서 아직 실행 중인 스텝이 있습니다", { stepRunId: step.id }));
    }
  }
  // [liveness 교정 2026-10-22] 종료 스텝/이슈의 잔여 참조(도구 큐 예약·소유권·체크아웃/실행)는
  //   참조된 wakeup/heartbeat 의 실제 상태를 읽어 활성일 때만 차단한다.
  blockers.push(...activeResidueBlockers(
    history.missionSteps,
    history.history.issues,
    new Map(history.history.wakeups.map((row) => [row.id, row.status])),
    new Map(history.history.heartbeats.map((row) => [row.id, row.status])),
    { stuckStepRunIds },
  ));
  for (const delegation of history.history.delegations) {
    // [임시 conservative proof gap] status allowlist 를 발명하지 않는다 — delegation 존재 자체가
    // active_work. 상위가 실제 전환 소스를 확정하기 전까지 settled 아니다.
    blockers.push(activeWork("위임 기록이 남아 있어 종료 전환 여부가 증명되지 않았습니다", { delegationId: delegation.id }));
  }
  for (const request of requests) {
    if (request.state === "pending_delivery") {
      blockers.push(activeWork("미완료 resume 요청이 남아 있습니다", { requestId: request.id }));
    }
  }
  for (const execution of executions) {
    if (ACTIVE_EXECUTION_STATES.has(execution.state)) {
      blockers.push(activeWork("재개 실행이 아직 대기/진행 중입니다", { executionId: execution.id }));
    }
  }
  return blockers;
}

/** [liveness 교정 2026-10-22] 잔여 흔적 판정용 좁은 구조 — 전체 행에서 id/status/참조만 읽는다. */
export interface StepResidueFacts {
  id: string;
  status: string;
  issueId?: string | null;
  dispatchOwnerWakeupRequestId: string | null;
  dispatchOwnerHeartbeatRunId: string | null;
  metadata: Record<string, unknown>;
}

export interface IssueResidueFacts {
  id: string;
  status: string;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

/**
 * 미션 전체 잔여 흔적의 활성 판정 — 종료 스텝의 toolQueue/소유권 참조와 이슈 체크아웃/실행 참조는
 * 참조된 wakeup/heartbeat 가 실제 활성(비종말)일 때만 active_work 로 차단한다. 종료 기록 참조는
 * 과거 흔적이고, 참조가 수집 집합에서 누락되면 증명 불가로 활성 취급한다(fail-closed 유지).
 */
export function activeResidueBlockers(
  steps: StepResidueFacts[],
  issues: IssueResidueFacts[],
  wakeupStatusById: ReadonlyMap<string, string>,
  heartbeatStatusById: ReadonlyMap<string, string>,
  opts?: { stuckStepRunIds?: ReadonlySet<string> },
): ResumePreviewBlocker[] {
  const blockers: ResumePreviewBlocker[] = [];
  const stuckStepRunIds = opts?.stuckStepRunIds;
  const stuckBoundIssueIds = stuckStepRunIds
    ? new Set(steps.filter((step) => stuckStepRunIds.has(step.id)).map((step) => step.issueId).filter((id): id is string => typeof id === "string"))
    : undefined;
  const wakeupActive = (id: string | null): boolean => {
    if (id === null) return false;
    const status = wakeupStatusById.get(id);
    return status === undefined || !TERMINAL_WAKEUP_STATUSES.has(status);
  };
  const heartbeatActive = (id: string | null): boolean => {
    if (id === null) return false;
    const status = heartbeatStatusById.get(id);
    return status === undefined || !TERMINAL_HEARTBEAT_STATUSES.has(status);
  };
  for (const step of steps) {
    const stepTerminal = TERMINAL_STEP_STATUSES.has(step.status);
    if (step.dispatchOwnerWakeupRequestId !== null || step.dispatchOwnerHeartbeatRunId !== null) {
      // [stuck] isStepRunStuck 은 오너 참조가 전부 종말임을 증명한 스텝만 통과시킨다 —
      //   참조가 살아있으면 wakeupActive/heartbeatActive 분기가 여전히 차단한다.
      if ((!stepTerminal && !stuckStepRunIds?.has(step.id))
        || wakeupActive(step.dispatchOwnerWakeupRequestId)
        || heartbeatActive(step.dispatchOwnerHeartbeatRunId)) {
        blockers.push(activeWork("스텝에 웨이크업/하트비트 소유권이 남아 있습니다", { stepRunId: step.id }));
      }
    }
    if (!stepTerminal && hasOwnNonNull(step.metadata, "toolQueue")) {
      blockers.push(activeWork("스텝에 도구 큐 잔존 기록이 있습니다", { stepRunId: step.id }));
    }
  }
  for (const issue of issues) {
    // [stuck] stuck 스텝에 묶인 이슈의 in_progress 는 checkout/execution 참조가 죽었을 때만
    //   residue 차단을 bypass 한다 — 참조가 활성이면 그대로 active_work.
    const refsActive = heartbeatActive(issue.checkoutRunId) || heartbeatActive(issue.executionRunId);
    if (refsActive || (issue.status === "in_progress" && !stuckBoundIssueIds?.has(issue.id))) {
      blockers.push(activeWork("이슈에 활성 실행/체크아웃 흔적이 남아 있습니다", { issueId: issue.id }));
    }
  }
  return blockers;
}

function hasOwnNonNull(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== null && record[key] !== undefined;
}

/** 계약 6 — 예산 값은 safe 비음수 정수여야 한다. 0 은 기존 무제한 관례(costs/companies). */
export function budgetBlockers(budget: { budgetMonthlyCents: unknown; spentMonthlyCents: unknown }): ResumePreviewBlocker[] {
  const isSafeNonNegativeInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!isSafeNonNegativeInt(budget.budgetMonthlyCents) || !isSafeNonNegativeInt(budget.spentMonthlyCents)) {
    return [{ code: "budget_unknown", message: "회사 예산 값을 판독할 수 없습니다" }];
  }
  if (budget.budgetMonthlyCents > 0 && budget.spentMonthlyCents >= budget.budgetMonthlyCents) {
    return [{ code: "budget_exceeded", message: "회사 월간 예산이 소진되었습니다" }];
  }
  return [];
}

/** 계약 3 — 실제 행 필드 + 전체 이력에서 StepHistory 를 만든다(row id 기준 typed 대조). */
export function stepFactsFor(
  row: StepRow,
  kind: StepHistory["kind"],
  effect: StepHistory["effect"],
  history: ResumeWorkspaceMissionHistory,
  opts?: { stuck?: boolean },
): StepHistory {
  const stepRunId = row.id;
  const heartbeatMatched = history.history.heartbeats.some((hb) => hb.workflowStepRunId === stepRunId);
  const wakeupMatched = history.history.wakeups.some((wake) => wake.workflowStepRunId === stepRunId);
  const delegationMatched = history.history.delegations.some((del) => del.sourceWorkflowStepRunId === stepRunId);
  return {
    stepId: row.stepId,
    status: row.status,
    issueId: row.issueId,
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    executionGeneration: row.executionGeneration,
    hasAttempt: row.lastDispatchAttemptAt !== null || row.lastDispatchAcceptedAt !== null
      || row.lastDispatchRequestId !== null || heartbeatMatched || wakeupMatched || delegationMatched,
    hasQueue: hasOwnNonNull(row.metadata, "toolQueue"),
    hasOwner: row.dispatchOwnerWakeupRequestId !== null && row.dispatchOwnerHeartbeatRunId !== null,
    hasExternalResult: row.evidenceReadyAt !== null,
    effect,
    kind,
    stuck: opts?.stuck === true,
  };
}

/** factsHash 용 JSON-safe canonical 변환 — Date → ISO. */
export function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

/** 계약 8 — factsHash 원천 raw 레코드 전체(registry/policy/product/request 포함).
 *   evidence 는 outside predecessor 검증 통과 항목(id=step run id, sha256=산출물 바이트 해시)이다. */
export interface SnapshotStateFacts {
  company: typeof companies.$inferSelect;
  workProducts: (typeof issueWorkProducts.$inferSelect)[];
  requests: ResumeRequestRow[];
  executions: ResumeExecutionRow[];
  registryRows: (typeof toolDefinitions.$inferSelect)[];
  policy: ReviewedResumePolicy | null;
  evidence: Array<{ id: string; sha256: string }>;
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
/**
 * 계약 8 — SnapshotState 를 정확 키로 조립한다. evidence 는 검증 통과한 outside predecessor
 *   산출물 목록(facts.evidence, id 오름차순 가정),
 * approvals 는 policy 필수 목록 중 affected 안의 것(현재 generation+1, bindingHash null),
 * resumeEpoch 은 run.metadata 의 own valid safe int(없으면 0, malformed 면 unsupported_status
 * blocker 기록). factsHash 는 현재 벽시계/run.updatedAt 를 포함하지 않는다.
 */
export function buildSnapshotState(
  history: ResumeWorkspaceMissionHistory,
  scope: ResumeExecutionHistoryScope,
  affected: string[],
  facts: SnapshotStateFacts,
  blockers: ResumePreviewBlocker[],
): SnapshotState {
  const run = history.selected.run;
  let resumeEpoch = 0;
  if (Object.prototype.hasOwnProperty.call(run.metadata, "resumeEpoch")) {
    const value = run.metadata.resumeEpoch;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) resumeEpoch = value;
    else blockers.push({ code: "unsupported_status", message: "run metadata 의 resumeEpoch 형식이 잘못되었습니다" });
  }
  const rowByStepId = new Map(history.selected.steps.map((row) => [row.stepId, row]));
  const affectedSet = new Set(affected);
  const approvals = approvalRequiredStepIds(facts.policy)
    .filter((stepId) => affectedSet.has(stepId))
    .map((stepId) => ({
      stepId,
      executionGeneration: rowByStepId.get(stepId)!.executionGeneration + 1,
      bindingHash: null,
    }));
  const factsHash = hashStructuredValue(jsonSafe({
    schemaVersion: 1,
    scope,
    mission: history.selected.mission,
    run,
    selectedSteps: history.selected.steps,
    missionRuns: history.missionRuns,
    missionSteps: history.missionSteps,
    ...history.history,
    ...history.resources,
    executionWorkspaces: history.executionWorkspaces,
    budget: { budgetMonthlyCents: facts.company.budgetMonthlyCents, spentMonthlyCents: facts.company.spentMonthlyCents },
    workProducts: facts.workProducts,
    requests: facts.requests,
    executions: facts.executions,
    registryRows: facts.registryRows,
    policy: facts.policy,
  }));
  const selectedRows = affected.map((stepId) => rowByStepId.get(stepId)!)
    .sort((a, b) => (a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0));
  return {
    schemaVersion: 1,
    scope,
    definitionHash: history.selected.definition.definitionHash,
    mission: { status: history.selected.mission.status, updatedAt: history.selected.mission.updatedAt.toISOString() },
    run: {
      status: run.status, dispatchAuthorityVersion: run.dispatchAuthorityVersion,
      startedAt: isoOrNull(run.startedAt), completedAt: isoOrNull(run.completedAt),
    },
    steps: selectedRows.map((row) => ({
      id: row.id,
      stepId: row.stepId,
      status: row.status,
      executionGeneration: row.executionGeneration,
      statusTransitionVersion: row.statusTransitionVersion,
      dispatchOwnerWakeupRequestId: row.dispatchOwnerWakeupRequestId,
      dispatchOwnerHeartbeatRunId: row.dispatchOwnerHeartbeatRunId,
      lastDispatchRequestId: row.lastDispatchRequestId,
    })),
    evidence: facts.evidence,
    approvals,
    resumeEpoch,
    factsHash,
  };
}
