import type { ResumeExecutionHistory } from "./read-model.js";
import {
  buildHistoryLinkIndex,
  collectServiceHeartbeatRefs,
  runScopeIdMissing,
} from "./observed-resource-links.js";

/**
 * [파일 목적] Task5c3b 관찰된(observed) resource 충돌 부정 필터 — 공급된 기록 행 안에서 활성
 *   충돌을 찾으면 blocker 를 반환하는 동기·순수 함수다. DB/fs/env/time/OS/network 읽기 없음,
 *   callback 없음, hash/sign 없음, ordinary unsupported 행에 예외를 던지지 않는다.
 *   read-model 은 타입 import 만 하고 collector/settlement/service/fs/process 를 실행하지 않는다.
 * [명시적 한계 — 이 필터의 빈 결과가 그 이상을 주장하지 않도록 유지할 것]
 *   - blockers 없음 = 공급된 행들에서 충돌을 못 찾았을 뿐이다. eligible/settled/quiescent
 *     boolean 이 아니며 token 을 발급하지 않는다. 총 정적(total quiescence)·역사적 부재 증명·
 *     resume 적격성이 아니다.
 *   - collector 가 공급하지 않은 shared-workspace/unmapped cleanup 행은 여기 없다 — 빈 배열이
 *     완전성의 증거로 쓰이지 않는다. collector 를 변경하지 않는다.
 *   - 이 필터는 멈춘 프로세스를 증명하지 않는다(프로세스 부재의 긍정 증명 없음). 기록된
 *     settlement 성공도 요구하지 않는다 — 이후 조립이 별도로 승인된 recorded-settlement
 *     검사기와 whole-mission fresh/lineage 검사를 호출한다.
 * [규칙(자원 행당 첫 실패 규칙 1개, 번호 순)]
 *   1) scope: 모든 자원의 companyId 일치, mission runtime 은 missionId 까지 일치. 해석되는 모든
 *      참조 heartbeat/issue 도 scope 일치(issue missionId null 은 legacy 허용). 위반 →
 *      scope_mismatch/resource_scope_mismatch. 범주별로 오염된 identity id 집합을 먼저 계산해
 *      모든 행에서 최우선 검사한다 — 같은 id 의 어떤 후보가 오염이면 identity 전체가
 *      scope_mismatch 하나이며 하위 규칙(모호 포함)은 추가로 내지 않는다.
 *   2) identity: 자기 id 가 범주 안에서 중복이거나 참조 heartbeat/issue id 가 중복이면
 *      scope_mismatch/resource_identity_ambiguous(중복 행을 Map 이 덮어쓰지 않는다).
 *   3) lineage: typed 컬럼 참조만(non-null + 공급 이력에서 해석). JSON/prose 파싱 없음. 미달 →
 *      active_work/resource_lineage_unproven.
 *   4) state: operation succeeded|failed|skipped, service stopped|failed(stoppedAt 있어도
 *      active 면 차단), runtime idle|stopped|crashed — 이외는 active_work/resource_not_terminal.
 *   5) ownership(runtime 만): currentIssueId !== null 또는 queueDepth !== 0(음수/소수/NaN 포함) →
 *      active_work/resource_owner_present. processPid/lastRunStatus 는 절대 사용하지 않는다.
 *   6) recorded timestamps: 유한 Date 검증만(벽시계 비교 없음). operation started<=finished,
 *      service started<=stopped, runtime 은 모든 nonnull 시각 유한 + stopped 에서만 stoppedAt
 *      필수와 started<=stopped 순서 비교(idle/crashed 는 순서를 비교하지 않는다).
 *      위반 → active_work/resource_terminal_record_unproven.
 */

export type ObservedResourceKind = "workspace_operation" | "workspace_service" | "mission_runtime";

export type ObservedResourceBlockerReason =
  | "resource_scope_mismatch"
  | "resource_identity_ambiguous"
  | "resource_lineage_unproven"
  | "resource_not_terminal"
  | "resource_owner_present"
  | "resource_terminal_record_unproven";

/** 빈 배열은 "공급된 행에서 충돌 없음"일 뿐 — 적격/정적/토큰 자격이 아니다. */
export type ObservedResourceBlocker = {
  code: "active_work" | "scope_mismatch";
  resourceKind: ObservedResourceKind;
  resourceId: string;
  reason: ObservedResourceBlockerReason;
};

export type ObservedResourceConflictsInput = Pick<
  ResumeExecutionHistory,
  "scope" | "issues" | "heartbeats" | "workspaceOperations" | "workspaceRuntimeServices" | "missionAgentRuntimes"
>;

type OperationRow = ResumeExecutionHistory["workspaceOperations"][number];
type ServiceRow = ResumeExecutionHistory["workspaceRuntimeServices"][number];
type RuntimeRow = ResumeExecutionHistory["missionAgentRuntimes"][number];

const TERMINAL_OPERATION_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "skipped"]);
const RECORDED_TERMINAL_SERVICE_STATES: ReadonlySet<string> = new Set(["stopped", "failed"]);
const INACTIVE_RUNTIME_BOOKKEEPING_STATES: ReadonlySet<string> = new Set(["idle", "stopped", "crashed"]);

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isFiniteDateOrNull(value: Date | null): boolean {
  return value === null || isValidDate(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 누적기 — 동일 (resourceKind, resourceId, code, reason) 중복 제거. 구분자 연결 문자열 키를
 * 만들지 않고 중첩 Map/Set 으로만 판정한다. 최종 배열은 codepoint 4단 정렬.
 */
function createBlockerSink() {
  const blockers: ObservedResourceBlocker[] = [];
  const emitted = new Map<ObservedResourceKind, Map<string, Map<ObservedResourceBlocker["code"], Set<ObservedResourceBlockerReason>>>>();
  function emit(
    code: ObservedResourceBlocker["code"],
    resourceKind: ObservedResourceKind,
    resourceId: string,
    reason: ObservedResourceBlockerReason,
  ): void {
    let byId = emitted.get(resourceKind);
    if (!byId) {
      byId = new Map();
      emitted.set(resourceKind, byId);
    }
    let byCode = byId.get(resourceId);
    if (!byCode) {
      byCode = new Map();
      byId.set(resourceId, byCode);
    }
    let byReason = byCode.get(code);
    if (!byReason) {
      byReason = new Set();
      byCode.set(code, byReason);
    }
    if (byReason.has(reason)) return;
    byReason.add(reason);
    blockers.push({ code, resourceKind, resourceId, reason });
  }
  return { blockers, emit };
}

/** 범주 안에서 2개 이상 나타나는 id 집합 — 각 중복 행이 그 id 의 모호를 보고한다. */
function duplicatedIdsInCategory(rows: readonly { id: string }[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) duplicated.add(row.id);
    else seen.add(row.id);
  }
  return duplicated;
}

/**
 * [규칙 1 선계산] identity 급 scope 오염 집합 — 같은 id 의 어떤 후보 행이 직접 scope 위반이거나
 *   해석되는 참조 heartbeat/issue 가 오염이면 그 id 자체를 오염으로 기록한다. 하위 규칙 전에
 *   모든 후보를 검사해야 순서 무관의 "identity 당 첫 실패 규칙 하나"가 보장된다(last-wins 금지).
 */
function collectContaminatedIds<Row extends { id: string }>(
  rows: readonly Row[],
  contaminated: (row: Row) => boolean,
): Set<string> {
  const contaminatedIds = new Set<string>();
  for (const row of rows) {
    if (contaminated(row)) contaminatedIds.add(row.id);
  }
  return contaminatedIds;
}

/** 계약 전체 — 관찰된 resource 충돌 부정 필터 순수 진입점. caller 입력을 변이하지 않는다. */
export function checkObservedResourceConflicts(input: ObservedResourceConflictsInput): ObservedResourceBlocker[] {
  const scope = input.scope;
  const links = buildHistoryLinkIndex(scope, input.issues, input.heartbeats);
  const { blockers, emit } = createBlockerSink();
  const duplicatedOperationIds = duplicatedIdsInCategory(input.workspaceOperations);
  const duplicatedServiceIds = duplicatedIdsInCategory(input.workspaceRuntimeServices);
  const duplicatedRuntimeIds = duplicatedIdsInCategory(input.missionAgentRuntimes);
  // [규칙 1] identity 급 오염 선계산 — 직접 company/mission 위반 + 해석되는 참조 후보의 오염까지.
  const contaminatedOperationIds = collectContaminatedIds(input.workspaceOperations, (row) =>
    row.companyId !== scope.companyId
    || (row.heartbeatRunId !== null && links.heartbeatResolves(row.heartbeatRunId)
      && links.heartbeatOutOfScope(row.heartbeatRunId)));
  const contaminatedServiceIds = collectContaminatedIds(input.workspaceRuntimeServices, (row) =>
    row.companyId !== scope.companyId
    || collectServiceHeartbeatRefs(row).some((refId) => links.heartbeatResolves(refId) && links.heartbeatOutOfScope(refId))
    || (row.issueId !== null && links.issueResolves(row.issueId) && links.issueOutOfScope(row.issueId)));
  const contaminatedRuntimeIds = collectContaminatedIds(input.missionAgentRuntimes, (row) =>
    row.companyId !== scope.companyId
    || row.missionId !== scope.missionId
    || (row.lastRunId !== null && links.heartbeatResolves(row.lastRunId)
      && links.heartbeatOutOfScope(row.lastRunId))
    || (row.currentIssueId !== null && links.issueResolves(row.currentIssueId)
      && links.issueOutOfScope(row.currentIssueId)));

  function checkWorkspaceOperation(row: OperationRow): void {
    if (contaminatedOperationIds.has(row.id)) {
      emit("scope_mismatch", "workspace_operation", row.id, "resource_scope_mismatch");
      return;
    }
    if (duplicatedOperationIds.has(row.id)
      || (row.heartbeatRunId !== null && links.isDuplicateHeartbeat(row.heartbeatRunId))) {
      emit("scope_mismatch", "workspace_operation", row.id, "resource_identity_ambiguous");
      return;
    }
    // [규칙 3] typed heartbeatRunId 컬럼이 nonnull 이고 공급 이력에서 해석되어야 한다.
    if (row.heartbeatRunId === null || !links.heartbeatResolves(row.heartbeatRunId)) {
      emit("active_work", "workspace_operation", row.id, "resource_lineage_unproven");
      return;
    }
    if (!TERMINAL_OPERATION_STATES.has(row.status)) {
      emit("active_work", "workspace_operation", row.id, "resource_not_terminal");
      return;
    }
    // [규칙 6] started/finished 유한 Date + finished >= started(동일 시각 허용).
    if (
      !isValidDate(row.startedAt)
      || !isValidDate(row.finishedAt)
      || row.finishedAt.getTime() < row.startedAt.getTime()
    ) {
      emit("active_work", "workspace_operation", row.id, "resource_terminal_record_unproven");
    }
  }

  function checkWorkspaceService(row: ServiceRow): void {
    const heartbeatRefs = collectServiceHeartbeatRefs(row);
    if (contaminatedServiceIds.has(row.id)) {
      emit("scope_mismatch", "workspace_service", row.id, "resource_scope_mismatch");
      return;
    }
    if (
      duplicatedServiceIds.has(row.id)
      || heartbeatRefs.some((refId) => links.isDuplicateHeartbeat(refId))
      || (row.issueId !== null && links.isDuplicateIssue(row.issueId))
    ) {
      emit("scope_mismatch", "workspace_service", row.id, "resource_identity_ambiguous");
      return;
    }
    // [규칙 3] run scope 의 null/empty scopeId, dangling 참조, 참조 0개는 모두 계보 미증명.
    //   non-run scopeId 는 heartbeat 가 아니므로 issue-only 연관만으로도 족하다.
    if (
      runScopeIdMissing(row)
      || !heartbeatRefs.every((refId) => links.heartbeatResolves(refId))
      || (row.issueId !== null && !links.issueResolves(row.issueId))
      || (heartbeatRefs.length === 0 && row.issueId === null)
    ) {
      emit("active_work", "workspace_service", row.id, "resource_lineage_unproven");
      return;
    }
    // [규칙 4] 기록된 단말은 stopped|failed + stoppedAt — active+stoppedAt 도 차단된다.
    if (!RECORDED_TERMINAL_SERVICE_STATES.has(row.status)) {
      emit("active_work", "workspace_service", row.id, "resource_not_terminal");
      return;
    }
    if (
      !isValidDate(row.startedAt)
      || !isValidDate(row.stoppedAt)
      || row.stoppedAt.getTime() < row.startedAt.getTime()
    ) {
      emit("active_work", "workspace_service", row.id, "resource_terminal_record_unproven");
    }
  }

  function checkMissionRuntime(row: RuntimeRow): void {
    if (contaminatedRuntimeIds.has(row.id)) {
      emit("scope_mismatch", "mission_runtime", row.id, "resource_scope_mismatch");
      return;
    }
    if (
      duplicatedRuntimeIds.has(row.id)
      || (row.lastRunId !== null && links.isDuplicateHeartbeat(row.lastRunId))
      || (row.currentIssueId !== null && links.isDuplicateIssue(row.currentIssueId))
    ) {
      emit("scope_mismatch", "mission_runtime", row.id, "resource_identity_ambiguous");
      return;
    }
    // [규칙 3] lastRunId 필수이고 currentIssueId 의 해석은 소유 규칙보다 먼저 — dangling 소유는
    //   owner_present 가 아니라 lineage 미증명으로 차단한다. runtimeKey/session/stateJson/
    //   lastError 파싱은 하지 않는다.
    if (
      row.lastRunId === null
      || !links.heartbeatResolves(row.lastRunId)
      || (row.currentIssueId !== null && !links.issueResolves(row.currentIssueId))
    ) {
      emit("active_work", "mission_runtime", row.id, "resource_lineage_unproven");
      return;
    }
    if (!INACTIVE_RUNTIME_BOOKKEEPING_STATES.has(row.status)) {
      emit("active_work", "mission_runtime", row.id, "resource_not_terminal");
      return;
    }
    // [규칙 5] 소유 존재 — starting/ready/busy 가 아니어도(currentIssueId 잔존, queueDepth != 0)
    //   활성 소유다. processPid 는 null 이든 유지되든 결과에 영향이 없고 lastRunStatus 는 안 본다.
    if (row.currentIssueId !== null || row.queueDepth !== 0) {
      emit("active_work", "mission_runtime", row.id, "resource_owner_present");
      return;
    }
    // [규칙 6] 모든 nonnull startedAt/stoppedAt 는 유한 Date. 순서 비교 started<=stopped 와
    //   stoppedAt 필수는 status 가 정확히 'stopped' 일 때만 적용한다 — idle/crashed 는 유한성만
    //   검사하고 순서를 비교하지 않는다(원계약). createdAt/updatedAt 이나 heartbeat 정산 시점으로
    //   추론하지 않는다.
    if (
      !isFiniteDateOrNull(row.startedAt)
      || !isFiniteDateOrNull(row.stoppedAt)
      || (row.status === "stopped" && !isValidDate(row.stoppedAt))
      || (row.status === "stopped" && isValidDate(row.startedAt) && isValidDate(row.stoppedAt)
        && row.stoppedAt.getTime() < row.startedAt.getTime())
    ) {
      emit("active_work", "mission_runtime", row.id, "resource_terminal_record_unproven");
    }
  }

  for (const row of input.workspaceOperations) checkWorkspaceOperation(row);
  for (const row of input.workspaceRuntimeServices) checkWorkspaceService(row);
  for (const row of input.missionAgentRuntimes) checkMissionRuntime(row);

  return blockers.sort((a, b) =>
    compareStrings(a.resourceKind, b.resourceKind)
    || compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.code, b.code)
    || compareStrings(a.reason, b.reason));
}
