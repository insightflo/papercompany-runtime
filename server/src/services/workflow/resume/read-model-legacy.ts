import { inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * [파일 목적] Task5c2b — legacy JSON-only 이력 연관 발견용 최소 SQL 술어 헬퍼.
 *   read-model-history 의 wakeups(payload)·heartbeats(contextSnapshot) 조회에 붙는 OR 술어를
 *   만든다. typed queue 컬럼이 비어 있어도 최상위 JSON 문자열 키 참조로 과거 실행 연관을
 *   놓치지 않기 위한 reader 보강이다.
 * [불변식]
 *   - 수집일 뿐이다: JSON 링크는 resume 승인이나 producer 신원의 증거가 아니라 "가능한 연관"의
 *     수집이다. 완전한 lineage/quiescence/evidence 주장은 하지 않는다.
 *   - 정확한 최상위 JSON "문자열" 동등 비교만 한다. jsonb_typeof(column -> key) = 'string' 가드로
 *     JSON null/object/array/number/boolean 값과 문자열이 아닌 전체 컬럼(scalar/array/누락)은
 *     전부 무시된다.
 *   - UUID 캐스팅이 없다: column ->> key 텍스트 비교만 하므로 malformed 문자열이 SQL 예외를
 *     내지 않는다. trim/정규화도 없다 — 공백 포함·산문 속 ID·중첩 객체는 동등하지 않아 무시.
 *   - substring/regex/재귀 text scan/앱 단 JSON decode/무한정 table fetch 없음. 키는 아래의
 *     고정 상수이고(클라이언트 입력 아님), 모든 id 값은 바운드 SQL 파라미터로 전달된다.
 */

/** 고정 키 상수 — heartbeat deriveTaskKey / payload mirror 경로가 쓰는 것과 동일한 이름들. */
const KEY_MISSION_ID = "missionId";
const KEY_WORKFLOW_RUN_ID = "workflowRunId";
const KEY_WORKFLOW_STEP_RUN_ID = "workflowStepRunId";
const KEY_ISSUE_ID = "issueId";
const KEY_TASK_ID = "taskId";
const KEY_TASK_KEY = "taskKey";

/** [내부] 최상위 JSON 문자열 == 단일 값. 키는 고정 상수이므로 SQL 텍스트로만 인라인된다. */
function jsonStringEquals(column: AnyPgColumn, key: string, value: string): SQL {
  const jsonKey = sql.raw(`'${key}'`);
  return sql`(jsonb_typeof(${column} -> ${jsonKey}) = 'string' and ${column} ->> ${jsonKey} = ${value})`;
}

/** [내부] 최상위 JSON 문자열 IN 목록. values 가 비어 있으면 호출하지 않는다. */
function jsonStringIn(column: AnyPgColumn, key: string, values: string[]): SQL {
  const jsonKey = sql.raw(`'${key}'`);
  return sql`(jsonb_typeof(${column} -> ${jsonKey}) = 'string' and ${inArray(sql`${column} ->> ${jsonKey}`, values)})`;
}

/**
 * legacy JSON 연관 술어 전체(기존 OR 질의에 그대로 붙이는 개별 술어 배열).
 * missionId/workflowRunId 는 항상, workflowStepRunId 는 stepRunIds 가, issueId/taskId/taskKey 는
 * issueIds 가 비어 있지 않을 때만 포함된다 — invalid SQL(`in ()`) 회피.
 */
export function legacyHistoryPredicates(
  column: AnyPgColumn,
  scope: { missionId: string; workflowRunId: string },
  stepRunIds: string[],
  issueIds: string[],
): SQL[] {
  const predicates: SQL[] = [
    jsonStringEquals(column, KEY_MISSION_ID, scope.missionId),
    jsonStringEquals(column, KEY_WORKFLOW_RUN_ID, scope.workflowRunId),
  ];
  if (stepRunIds.length > 0) {
    predicates.push(jsonStringIn(column, KEY_WORKFLOW_STEP_RUN_ID, stepRunIds));
  }
  if (issueIds.length > 0) {
    for (const key of [KEY_ISSUE_ID, KEY_TASK_ID, KEY_TASK_KEY]) {
      predicates.push(jsonStringIn(column, key, issueIds));
    }
  }
  return predicates;
}
