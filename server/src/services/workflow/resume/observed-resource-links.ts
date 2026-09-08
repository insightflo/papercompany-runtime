import type { ResumeExecutionHistory } from "./read-model.js";

/**
 * [파일 목적] Task5c3b observed-resource 부정 필터의 링크 인덱스(순수, 크기 분할 전용 로컬
 *   헬퍼). runtime import 가 없다 — read-model 의 타입만 import 하고, 호출자가 공급한 전체 행
 *   배열 위에서 중복 인지(duplicate-aware) 참조 인덱스와 service 의 typed heartbeat 참조
 *   수집만 담당한다. DB/fs/env/time/OS/network 읽기 없음, callback 없음, caller 배열 변이 없음.
 * [불변식 — .pi/LESSONS.md 중복 인덱스 함정 재발 방지]
 *   - Map overwrite 로 last-wins 권위를 만들지 않는다: 한 id 에 행이 2개 이상이면 그 id 자체를
 *     모호로 기록하고, scope 오염은 모든 후보 행을 검사해 하나라도 걸리면 오염으로 본다
 *     (입력 순서와 무관).
 *   - delimiter 연결 문자열 키를 만들지 않는다 — 단일 id 키의 Map 만 사용한다.
 *   - 참조 해석은 typed DB 컬럼 문자열 동등만 사용한다. JSON/prose 파싱은 하지 않는다.
 *   - unresolved 참조의 out-of-scope 는 false 다 — dangling 은 scope 위반이 아니라 lineage
 *     (계보 미증명) 규칙의 대상이다. 이 인덱스는 판정 재료만 준다.
 */

type HeartbeatRow = ResumeExecutionHistory["heartbeats"][number];
type IssueRow = ResumeExecutionHistory["issues"][number];
type HistoryScope = ResumeExecutionHistory["scope"];
type ServiceRow = ResumeExecutionHistory["workspaceRuntimeServices"][number];

/** 하나의 참조 id 에 대한 해석/중복/scope 판정을 묶은 불변 조회 인덱스. */
export interface ResourceLinkIndex {
  /** 공급된 이력 안에 그 id 의 행이 하나 이상 존재하는가(dangling 판정용). */
  heartbeatResolves(refId: string): boolean;
  issueResolves(refId: string): boolean;
  /** 그 id 를 참조하면 scope 위반인가 — 후보 행 하나라도 company/mission 이 탈 scope 면 true. */
  heartbeatOutOfScope(refId: string): boolean;
  issueOutOfScope(refId: string): boolean;
  /** 그 id 의 행이 2개 이상 공급되어 참조 자체가 모호한가(no last-wins). */
  isDuplicateHeartbeat(refId: string): boolean;
  isDuplicateIssue(refId: string): boolean;
}

function indexRows<Row extends { id: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const byId = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byId.get(row.id);
    if (list) list.push(row);
    else byId.set(row.id, [row]);
  }
  return byId;
}

function duplicatedKeys(byId: Map<string, unknown[]>): Set<string> {
  const duplicated = new Set<string>();
  for (const [id, rows] of byId) {
    if (rows.length > 1) duplicated.add(id);
  }
  return duplicated;
}

/**
 * 이력(issues/heartbeats) 전체를 중복 인지 인덱스로 묶는다. issue 의 missionId null 은 legacy
 * 연관으로 scope 위반이 아니며, nonnull 타 mission 만 오염으로 본다. heartbeat 에는 mission
 * 컬럼이 없으므로 company 만 검사한다.
 */
export function buildHistoryLinkIndex(
  scope: HistoryScope,
  issues: readonly IssueRow[],
  heartbeats: readonly HeartbeatRow[],
): ResourceLinkIndex {
  const heartbeatRows = indexRows(heartbeats);
  const issueRows = indexRows(issues);
  const duplicateHeartbeatIds = duplicatedKeys(heartbeatRows);
  const duplicateIssueIds = duplicatedKeys(issueRows);

  // [scope 오염] 중복 후보 전부를 검사 — 하나라도 오염이면 그 id 참조는 오염(조용한 last-wins 금지).
  const contaminatedHeartbeatIds = new Set<string>();
  for (const [id, rows] of heartbeatRows) {
    if (rows.some((row) => row.companyId !== scope.companyId)) contaminatedHeartbeatIds.add(id);
  }
  const contaminatedIssueIds = new Set<string>();
  for (const [id, rows] of issueRows) {
    if (rows.some((row) =>
      row.companyId !== scope.companyId
      || (row.missionId !== null && row.missionId !== scope.missionId))) {
      contaminatedIssueIds.add(id);
    }
  }

  return {
    heartbeatResolves: (refId) => heartbeatRows.has(refId),
    issueResolves: (refId) => issueRows.has(refId),
    heartbeatOutOfScope: (refId) => contaminatedHeartbeatIds.has(refId),
    issueOutOfScope: (refId) => contaminatedIssueIds.has(refId),
    isDuplicateHeartbeat: (refId) => duplicateHeartbeatIds.has(refId),
    isDuplicateIssue: (refId) => duplicateIssueIds.has(refId),
  };
}

/**
 * service 의 typed heartbeat 참조 수집: nonnull startedByRunId 와, scopeType 이 정확히 'run'일
 * 때만 비어있지 않은 scopeId. non-run scopeId 는 문자열이 heartbeat id 와 같아도 heartbeat 로
 * 해석하지 않는다(다른 known heartbeat 참조의 공존은 정당한 재사용으로 허용한다).
 */
export function collectServiceHeartbeatRefs(row: ServiceRow): string[] {
  const refs: string[] = [];
  if (row.startedByRunId !== null) refs.push(row.startedByRunId);
  if (row.scopeType === "run" && row.scopeId !== null && row.scopeId !== "") refs.push(row.scopeId);
  return refs;
}

/** run scope 이지만 scopeId 가 null/empty 여서 lineage 자체가 미증명인 경우 판정. */
export function runScopeIdMissing(row: ServiceRow): boolean {
  return row.scopeType === "run" && (row.scopeId === null || row.scopeId === "");
}
