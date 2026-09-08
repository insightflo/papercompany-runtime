import type { ResumeExecutionHistory } from "./read-model.js";

/**
 * [파일 목적] Task5c4a 관찰된(observed) wakeup/heartbeat 충돌 부정 필터 — 공급된 기록 행 안에서
 *   서로 상충하는 wakeup 요청과 끊어진 typed wakeup/heartbeat 링크를 찾아 blocker 를 반환하는
 *   동기·순수 함수다. DB/fs/env/time/OS/network 읽기 없음, callback 없음, 벽시계 없음,
 *   JSON/prose 파싱 없음, hash/sign 없음.
 * [runtime caller 없음] 이 모듈을 부르는 런타임 경로는 없다 — 이후 assembler 가 모든 부정
 *   필터를 조립할 예정이다. 여기의 빈 결과는 그 조립이 증명하는 완전성의 일부가 아니다.
 * [명시적 한계 — 빈 결과가 그 이상을 주장하지 않도록 유지할 것]
 *   - blockers 없음 = 공급된 행들에서 충돌을 못 찾았을 뿐이다. resume 적격성/quiescence/정산
 *     증명 boolean 이 아니며 token 을 발급하지 않는다. 조립자가 별도로 모든 필터를 실행하고
 *     완전성을 증명해야 한다.
 *   - 공급된 heartbeat status 는 기록된 bookkeeping 일 뿐, 프로세스 부재나 정산의 증거가
 *     아니다. 무링크 heartbeat 의 상태/정산은 recorded-settlement 검사기 소관이며 이 함수는
 *     그 대체가 아니다(규칙 5는 wakeup 과 직접 링크된 heartbeat 만 검사한다).
 *   - 기존 linked-history 수집기가 역참조 누락을 확인하지 않았어도 이 순수 검사기는 관찰된
 *     끊어진 역참조를 독립적으로 보고한다(수집기 변경 없음).
 *   - 공유 status enum 에 없는 `timed_out` 을 wakeup 상태로 로컬 허용한다(heartbeat.ts 가
 *     실제로 기록한다) — enum 자체는 수리하지 않는다.
 * [규칙(각 (resourceKind,id) 별 첫 실패 규칙 1개, 번호 순 — 각 규칙은 그 identity 의 모든
 *   후보를 검사한 뒤 다음 규칙으로 가므로 입력 순서가 순위에 영향을 주지 않는다)]
 *   1) scope: 자기 후보 company 불일치, wakeup 후보 nonnull missionId 불일치(heartbeat 에는
 *      mission 컬럼이 없다), 또는 직접 링크된 반대편 후보가 위 자기 규칙 위반, 또는 실제
 *      edge(양방향 참조 union) 양 끝 후보의 agentId 불일치 → scope_mismatch/
 *      wakeup_scope_mismatch. agent 비교는 실제 edge 한정(무관한 행 아님)이며 직접 인접을
 *      넘는 전이 오염 없음. null mission 은 legacy 허용. workflowRunId/generation 비교 없음 —
 *      whole-mission 입력에는 이전/다른 run 행이 포함된다.
 *   2) identity: 자기 그룹 길이 >1 또는 직접 링크된 반대편 그룹 길이 >1 → scope_mismatch/
 *      wakeup_identity_ambiguous. last-wins Map 없이 모든 후보를 보존하고 중복 identity 는
 *      1회만 보고한다. 하나의 heartbeat 에 여러 wakeup 요청은 정상이므로 상호 1:1 을 요구하지
 *      않는다.
 *   3) links: wakeup 의 nonnull runId 가 공급 heartbeats 에 없거나, status 가 coalesced 인데
 *      runId 가 null 이면 → active_work/wakeup_link_unproven. heartbeat 의 nonnull
 *      wakeupRequestId 가 공급 wakeups 에 없어도 같은 이유로 보고한다. null runId + 관찰된
 *      역방향 heartbeat 는 허용되며 아래 규칙에서 계속 검사된다. wakeup 이 heartbeat A 를
 *      가리키고 역방향으로 heartbeat B 가 붙는 비상호성만으로 거부하지 않고 A/B 둘 다 검사한다.
 *      null wakeupRequestId 허용, 고아 heartbeat 에 wakeup 을 요구하지 않는다. nonnull 이지만
 *      없는 참조를 null 로 간주하지 않는다.
 *   4) wakeup 상태만: coalesced|skipped|completed|failed|cancelled|timed_out 허용, 그 외
 *      (queued/deferred_issue_execution/claimed/unknown 포함) → active_work/
 *      wakeup_not_terminal. finishedAt 유무는 무관하다.
 *   5) wakeup 링크 activity 만: 직접 링크된(양방향) heartbeat 상태가 succeeded|failed|
 *      cancelled|timed_out 밖이면 → active_work/wakeup_linked_heartbeat_not_terminal.
 *      forward/reverse 독립적이며 wakeup 이 completed/skipped/cancelled 여도 적용된다.
 *   6) wakeup 기록만: requestedAt/finishedAt 는 유한 Date, finishedAt >= requestedAt(동일
 *      시각 허용), claimedAt 는 null 또는 유한 Date(추가 순서 제약 없음) → 위반 시
 *      active_work/wakeup_terminal_record_unproven. 이 외 날짜/확정 필드는 여기서 검사하지
 *      않는다.
 *   규칙 4-6 은 heartbeat-kind blocker 를 내지 않는다 — heartbeat-kind 출력은 전부 규칙 1-3의
 *   typed identity/scope/reference 진단이다. 정렬은 codepoint 오름차순
 *   resourceKind/resourceId/code/reason(`<`/`>` 비교, localeCompare 금지), caller 배열/행
 *   변이 없음, 구분자 연결 문자열 키 없이 중첩 Map/Set 만 사용한다.
 */

export type ObservedWakeupConflictsInput = Pick<
  ResumeExecutionHistory,
  "scope" | "wakeups" | "heartbeats"
>;

export type ObservedWakeupBlockerReason =
  | "wakeup_scope_mismatch"
  | "wakeup_identity_ambiguous"
  | "wakeup_link_unproven"
  | "wakeup_not_terminal"
  | "wakeup_linked_heartbeat_not_terminal"
  | "wakeup_terminal_record_unproven";

/** 빈 배열은 "공급된 행에서 충돌 없음"일 뿐 — 적격/정적/토큰 자격이 아니다. */
export type ObservedWakeupBlocker = {
  code: "scope_mismatch" | "active_work";
  resourceKind: "wakeup" | "heartbeat";
  resourceId: string;
  reason: ObservedWakeupBlockerReason;
};

type WakeRow = ResumeExecutionHistory["wakeups"][number];
type HeartbeatRow = ResumeExecutionHistory["heartbeats"][number];

const TERMINAL_WAKE_STATES: ReadonlySet<string> = new Set([
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const TERMINAL_HEARTBEAT_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** last-wins 없이 동일 id 후보를 전부 보존하는 그룹핑(새 배열 — caller 배열 변이 없음). */
function groupById<Row extends { id: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const byId = new Map<string, Row[]>();
  for (const row of rows) {
    const group = byId.get(row.id);
    if (group) group.push(row);
    else byId.set(row.id, [row]);
  }
  return byId;
}

/** 자기 후보 행의 직접 scope 규칙(heartbeat 에는 mission 컬럼이 없어 company 만 검사). */
function wakeOwnScopeViolation(scope: ObservedWakeupConflictsInput["scope"], row: WakeRow): boolean {
  return row.companyId !== scope.companyId
    || (row.missionId !== null && row.missionId !== scope.missionId);
}

function heartbeatOwnScopeViolation(scope: ObservedWakeupConflictsInput["scope"], row: HeartbeatRow): boolean {
  return row.companyId !== scope.companyId;
}

/**
 * 계약 전체 — 관찰된 wakeup/heartbeat 충돌 부정 필터 순수 진입점. 빈 결과는 적격 플래그가
 * 아니다(파일 헤더 한계 참조). caller 입력은 절대 변이하지 않는다.
 */
export function checkObservedWakeupConflicts(input: ObservedWakeupConflictsInput): ObservedWakeupBlocker[] {
  const scope = input.scope;
  const wakeupsById = groupById(input.wakeups);
  const heartbeatsById = groupById(input.heartbeats);
  const suppliedHeartbeatIds = new Set(heartbeatsById.keys());
  const suppliedWakeupIds = new Set(wakeupsById.keys());

  // [직접 인접] 실제 edge 를 identity 집합 양방향으로만 기록 — nonnull wake.runId 와 nonnull
  //   heartbeat.wakeupRequestId 의 union(payload 해석 없음). 끊긴 참조도 이웃 id 로 남아
  //   조용히 버려지지 않는다(규칙 3 이 감지).
  const heartbeatNeighborsOfWake = new Map<string, Set<string>>();
  const wakeupNeighborsOfHeartbeat = new Map<string, Set<string>>();
  function addEdge(wakeId: string, heartbeatId: string): void {
    let hbSide = heartbeatNeighborsOfWake.get(wakeId);
    if (!hbSide) {
      hbSide = new Set();
      heartbeatNeighborsOfWake.set(wakeId, hbSide);
    }
    hbSide.add(heartbeatId);
    let wakeSide = wakeupNeighborsOfHeartbeat.get(heartbeatId);
    if (!wakeSide) {
      wakeSide = new Set();
      wakeupNeighborsOfHeartbeat.set(heartbeatId, wakeSide);
    }
    wakeSide.add(wakeId);
  }
  for (const wake of input.wakeups) {
    if (wake.runId !== null) addEdge(wake.id, wake.runId);
  }
  for (const heartbeat of input.heartbeats) {
    if (heartbeat.wakeupRequestId !== null) addEdge(heartbeat.wakeupRequestId, heartbeat.id);
  }

  const candidatesOf = {
    wake: (wakeId: string): WakeRow[] => wakeupsById.get(wakeId) ?? [],
    heartbeat: (heartbeatId: string): HeartbeatRow[] => heartbeatsById.get(heartbeatId) ?? [],
  };

  // [규칙 1 선계산] identity 급 scope 위반 — 자기 후보 + 직접 링크된 반대편 후보 + 실제 edge
  //   양 끝 agentId 비교까지 전부 검사해 순서 무관을 보장한다(전이 오염 없음).
  function wakeIdentityScopeViolation(wakeId: string): boolean {
    const candidates = candidatesOf.wake(wakeId);
    if (candidates.some((row) => wakeOwnScopeViolation(scope, row))) return true;
    for (const heartbeatId of heartbeatNeighborsOfWake.get(wakeId) ?? []) {
      const linked = candidatesOf.heartbeat(heartbeatId);
      if (linked.some((row) => heartbeatOwnScopeViolation(scope, row))) return true;
      for (const wakeRow of candidates) {
        for (const heartbeatRow of linked) {
          if (wakeRow.agentId !== heartbeatRow.agentId) return true;
        }
      }
    }
    return false;
  }

  function heartbeatIdentityScopeViolation(heartbeatId: string): boolean {
    const candidates = candidatesOf.heartbeat(heartbeatId);
    if (candidates.some((row) => heartbeatOwnScopeViolation(scope, row))) return true;
    for (const wakeId of wakeupNeighborsOfHeartbeat.get(heartbeatId) ?? []) {
      const linked = candidatesOf.wake(wakeId);
      if (linked.some((row) => wakeOwnScopeViolation(scope, row))) return true;
      for (const heartbeatRow of candidates) {
        for (const wakeRow of linked) {
          if (heartbeatRow.agentId !== wakeRow.agentId) return true;
        }
      }
    }
    return false;
  }

  // [규칙 2] 자기 그룹 또는 직접 링크된 반대편 그룹이 2개 이상이면 모호(last-wins 금지).
  function wakeIdentityAmbiguous(wakeId: string): boolean {
    if (candidatesOf.wake(wakeId).length > 1) return true;
    for (const heartbeatId of heartbeatNeighborsOfWake.get(wakeId) ?? []) {
      if (candidatesOf.heartbeat(heartbeatId).length > 1) return true;
    }
    return false;
  }

  function heartbeatIdentityAmbiguous(heartbeatId: string): boolean {
    if (candidatesOf.heartbeat(heartbeatId).length > 1) return true;
    for (const wakeId of wakeupNeighborsOfHeartbeat.get(heartbeatId) ?? []) {
      if (candidatesOf.wake(wakeId).length > 1) return true;
    }
    return false;
  }

  // [규칙 3] nonnull 끊긴 참조 또는 coalesced+null runId 는 링크 미증명(null 은 아니다).
  function wakeLinkUnproven(wakeId: string): boolean {
    return candidatesOf.wake(wakeId).some((row) =>
      (row.runId !== null && !suppliedHeartbeatIds.has(row.runId))
      || (row.status === "coalesced" && row.runId === null));
  }

  function heartbeatLinkUnproven(heartbeatId: string): boolean {
    return candidatesOf.heartbeat(heartbeatId).some((row) =>
      row.wakeupRequestId !== null && !suppliedWakeupIds.has(row.wakeupRequestId));
  }

  // [규칙 4] 허용 단말 상태 밖의 wakeup 후보가 하나라도 있으면 활성 상태.
  function wakeStateNotTerminal(wakeId: string): boolean {
    return candidatesOf.wake(wakeId).some((row) => !TERMINAL_WAKE_STATES.has(row.status));
  }

  // [규칙 5] 직접 링크된(양방향) 모든 heartbeat 후보의 상태 검사 — 완료 wakeup 에도 적용.
  function wakeLinkedHeartbeatActive(wakeId: string): boolean {
    for (const heartbeatId of heartbeatNeighborsOfWake.get(wakeId) ?? []) {
      if (candidatesOf.heartbeat(heartbeatId).some((row) => !TERMINAL_HEARTBEAT_STATES.has(row.status))) {
        return true;
      }
    }
    return false;
  }

  // [규칙 6] requestedAt/finishedAt 유한 Date + finished >= requested, claimedAt null|유한.
  function wakeTerminalRecordUnproven(wakeId: string): boolean {
    return candidatesOf.wake(wakeId).some((row) =>
      !isValidDate(row.requestedAt)
      || !isValidDate(row.finishedAt)
      || row.finishedAt.getTime() < row.requestedAt.getTime()
      || !(row.claimedAt === null || isValidDate(row.claimedAt)));
  }

  const blockers: ObservedWakeupBlocker[] = [];
  for (const [wakeId] of wakeupsById) {
    if (wakeIdentityScopeViolation(wakeId)) {
      blockers.push({ code: "scope_mismatch", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_scope_mismatch" });
      continue;
    }
    if (wakeIdentityAmbiguous(wakeId)) {
      blockers.push({ code: "scope_mismatch", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_identity_ambiguous" });
      continue;
    }
    if (wakeLinkUnproven(wakeId)) {
      blockers.push({ code: "active_work", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_link_unproven" });
      continue;
    }
    if (wakeStateNotTerminal(wakeId)) {
      blockers.push({ code: "active_work", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_not_terminal" });
      continue;
    }
    if (wakeLinkedHeartbeatActive(wakeId)) {
      blockers.push({ code: "active_work", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_linked_heartbeat_not_terminal" });
      continue;
    }
    if (wakeTerminalRecordUnproven(wakeId)) {
      blockers.push({ code: "active_work", resourceKind: "wakeup", resourceId: wakeId, reason: "wakeup_terminal_record_unproven" });
    }
  }
  // 규칙 4-6 은 heartbeat-kind blocker 를 내지 않는다(링크/identity/scope 진단만).
  for (const [heartbeatId] of heartbeatsById) {
    if (heartbeatIdentityScopeViolation(heartbeatId)) {
      blockers.push({ code: "scope_mismatch", resourceKind: "heartbeat", resourceId: heartbeatId, reason: "wakeup_scope_mismatch" });
      continue;
    }
    if (heartbeatIdentityAmbiguous(heartbeatId)) {
      blockers.push({ code: "scope_mismatch", resourceKind: "heartbeat", resourceId: heartbeatId, reason: "wakeup_identity_ambiguous" });
      continue;
    }
    if (heartbeatLinkUnproven(heartbeatId)) {
      blockers.push({ code: "active_work", resourceKind: "heartbeat", resourceId: heartbeatId, reason: "wakeup_link_unproven" });
    }
  }

  return blockers.sort((a, b) =>
    compareStrings(a.resourceKind, b.resourceKind)
    || compareStrings(a.resourceId, b.resourceId)
    || compareStrings(a.code, b.code)
    || compareStrings(a.reason, b.reason));
}
