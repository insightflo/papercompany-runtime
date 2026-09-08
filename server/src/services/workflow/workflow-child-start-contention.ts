// server/src/services/workflow/workflow-child-start-contention.ts
//
// [purpose] PostgreSQL 구조화 경합 오류 분류 전용 모듈(설계 §3).
//   object.code 와 error.cause 체인(최대 5단계, 순환 방지)에서 SQLSTATE 를 검사한다.
//   메시지/스택/정규식/클래스명 매칭은 금지(규칙 7/8 — 오류 텍스트는 실행 권위가 아니다).
//   57014 는 statement 취소/타임아웃과 코드를 공유하므로 경합으로 분류하지 않는다.
// [descope] 문자열 SQLSTATE 만 인정 — 숫자 40001/프로스/23505/23514/57014 는 경합 아님.
//   retry-admission 센티널(CHILD_START_ADMISSION_LOST 계열)은 재시도 입장 삭제로 함께 삭제됐다(D2).
const CONTENTION_SQLSTATES = new Set<string>(["55P03", "40P01", "40001"]);
const MAX_CAUSE_DEPTH = 5;

/**
 * 자식 시작 경계의 경합(lock_timeout 55P03 / deadlock 40P01 / serialization 40001) 여부.
 * 구조화 code/cause 체인만 검사한다. 알 수 없는 오류는 false(기존 실패 진단 유지).
 */
export function isChildStartContention(error: unknown): boolean {
  return hasContentionSqlState(error, 0, new Set<unknown>());
}

/**
 * SQLSTATE 57014(statement_timeout/cancel 포함) 여부 — 경합과 구분되는 DB 시간 초과.
 * 소유자 실패 정산으로 잘못 흡수되지 않게 호출자가 원본 오류를 전파할 때 사용한다.
 */
export function isChildStartDatabaseTimeout(error: unknown): boolean {
  return chainHas(error, "57014", 0, new Set<unknown>());
}

function hasContentionSqlState(error: unknown, depth: number, seen: Set<unknown>): boolean {
  if (depth > MAX_CAUSE_DEPTH || error == null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if (typeof error === "object") {
    const candidate = error as { code?: unknown; cause?: unknown };
    // [descope] typeof code === "string" 만 허용(숫자 코드/기타 타입 배제).
    if (typeof candidate.code === "string" && CONTENTION_SQLSTATES.has(candidate.code)) return true;
    if (candidate.cause !== undefined) return hasContentionSqlState(candidate.cause, depth + 1, seen);
  }
  return false;
}

function chainHas(error: unknown, sqlState: string, depth: number, seen: Set<unknown>): boolean {
  if (depth > MAX_CAUSE_DEPTH || error == null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if (typeof error === "object") {
    const candidate = error as { code?: unknown; cause?: unknown };
    if (candidate.code === sqlState) return true;
    if (candidate.cause !== undefined) return chainHas(candidate.cause, sqlState, depth + 1, seen);
  }
  return false;
}

/**
 * fence 소실 표시 전용 비공개 센티널(메시지 매칭 금지 — 참조 비교로만 식별한다).
 * 트랜잭션 내부에서 throw 하여 롤백을 유발하고, 트랜잭션 외부에서만 잡아 not-owner 로 변환한다.
 */
export const CHILD_START_FENCE_LOST = Symbol("workflow-child-start-fence-lost");

/** fence 소실 센티널을 운반하는 오류 — 메시지 매칭 대신 이 클래스/심볼로만 식별한다. */
export class ChildStartFenceLostError extends Error {
  readonly [CHILD_START_FENCE_LOST] = true as const;
  constructor() {
    super("workflow child start fence lost");
    this.name = "ChildStartFenceLostError";
  }
}

export function isChildStartFenceLost(error: unknown): boolean {
  return error instanceof ChildStartFenceLostError
    || (typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[CHILD_START_FENCE_LOST] === true);
}
