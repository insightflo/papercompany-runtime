// server/src/services/pg-error.ts
//
// [봇 bug·high 교정 — 스테이지 A] drizzle-orm 0.36+ 는 쿼리 실행 오류를
// DrizzleQueryError 로 감싸고 원본 Postgres 오류를 error.cause 체인에 둔다.
// 최상위 code 만 검사하는 판별식은 프로덕션 경로에서 SQLSTATE 를 놓친다.
// 저장소 관례(workflow-child-start-contention.ts 의 cause 체인 순회)를 공용 헬퍼로 뽑아
// 23505(unique_violation) 회복 경로들이 같은 판별을 쓰게 한다.

const MAX_CAUSE_DEPTH = 5;

/** 오류(과 cause 체인)에서 SQLSTATE 를 찾는다 — 못 찾으면 null. */
export function pgSqlStateOf(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; cause?: unknown };
      if (typeof candidate.code === "string" && /^[0-9][0-9A-Z]{4}$/.test(candidate.code)) return candidate.code;
      if (candidate.cause === undefined) return null;
      current = candidate.cause;
    } else {
      return null;
    }
  }
  return null;
}

/** unique_violation(23505) 판별 — 23505 회복 경로의 표준 관문. */
export function isPgUniqueViolation(error: unknown): boolean {
  return pgSqlStateOf(error) === "23505";
}
