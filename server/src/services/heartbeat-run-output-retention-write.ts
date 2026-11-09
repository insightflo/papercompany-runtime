/**
 * Heartbeat run 출력 보존 절단 — DB 내 절단 쓰기 계층
 *
 * [OOM 수리 2026-11-09] 큰 result_json 본문을 Node 로 가져와 JS 에서 절단하면
 *   배치당 수백 MB~GB 가 파싱·보유돼 V8 힙을 죽인다(A1 첫 스윽 ~2GB OOM 실측).
 *   절단은 PostgreSQL 안에서 UPDATE 한 문으로 수행하고, Node 에는 id·md5·바이트
 *   길이 같은 작은 행만 오간다.
 *
 * write-chokepoint 가드(scripts/check-run-status-write-chokepoint.mjs)의 DATA
 * 허용 목록 파일 — heartbeat_runs UPDATE 는 이 파일과 …-retention.ts 에만 둔다.
 *
 * 절단 형식은 capHeartbeatRunResultJsonForStorage(heartbeat-run-summary.ts)와
 * 같은 계약의 SQL 재현이다. 차이(문서화된 한계): PostgreSQL length()/left()/
 * right() 는 문자(코드포인트) 단위이고 JS 구현은 UTF-16 코드 유닛 단위다.
 * 보조 평면(astral) 문자가 없는 텍스트에서는 결과가 바이트 단위로 동일하고,
 * 섞이면 생략 문자 수·경계가 서로게이트 폭만큼 달라지지만 마커 형식·유효성·
 * 멱등성은 유지된다(jsonb 에는 고립 서로게이트가 저장될 수 없어 JS 의 경계
 * 백오프가 DB 저장값에선 발동하지 않는다).
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  STORED_OUTPUT_CAP_PER_SIDE,
  STORED_OUTPUT_TRUNCATE_THRESHOLD,
} from "./heartbeat-run-summary.js";
import { extractRows } from "./heartbeat-run-output-retention-shared.js";
import type { RetentionCandidate } from "./heartbeat-run-output-retention-shared.js";

// capOutputText 와 동일 마커: "\n...[truncated <N> chars; full output in run log file]...\n"
// 문자열 키이고 threshold 초과일 때만 바꾼다 — 키가 없거나 문자열이 아니면
// {} 를 concat 해 아무 변화도 없다(cap 함수의 typeof/신규 키 미추가 계약과 동일).
const STDOUT_CAP_CASE = sql`
  CASE WHEN jsonb_typeof(h.result_json -> 'stdout') = 'string'
        AND length(h.result_json ->> 'stdout') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD}
    THEN jsonb_build_object('stdout', to_jsonb(
      left(h.result_json ->> 'stdout', ${STORED_OUTPUT_CAP_PER_SIDE})
      || chr(10) || '...[truncated '
      || (length(h.result_json ->> 'stdout') - ${2 * STORED_OUTPUT_CAP_PER_SIDE})::text
      || ' chars; full output in run log file]...' || chr(10)
      || right(h.result_json ->> 'stdout', ${STORED_OUTPUT_CAP_PER_SIDE})))
    ELSE '{}'::jsonb END
`;
const STDERR_CAP_CASE = sql`
  CASE WHEN jsonb_typeof(h.result_json -> 'stderr') = 'string'
        AND length(h.result_json ->> 'stderr') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD}
    THEN jsonb_build_object('stderr', to_jsonb(
      left(h.result_json ->> 'stderr', ${STORED_OUTPUT_CAP_PER_SIDE})
      || chr(10) || '...[truncated '
      || (length(h.result_json ->> 'stderr') - ${2 * STORED_OUTPUT_CAP_PER_SIDE})::text
      || ' chars; full output in run log file]...' || chr(10)
      || right(h.result_json ->> 'stderr', ${STORED_OUTPUT_CAP_PER_SIDE})))
    ELSE '{}'::jsonb END
`;

export type RetentionBatchWriteRow = Pick<RetentionCandidate, "id" | "resultHash">;

export type RetentionBatchAppliedRow = {
  id: string;
  /** 갱신 후 result_json::text 의 octet_length — bytesSaved 계산용. */
  resultBytes: number;
};

/**
 * 한 배치를 UPDATE 한 문으로 절단한다. 조건부 갱신: 선별 시점의
 * md5(result_json::text) 와 같을 때만 적용해 선별→갱신 사이에 재기록된 행은
 * 건너뛴다(CAS — RETURNING 에 나타나지 않는다).
 */
export async function truncateRetentionBatch(
  db: Db,
  rows: RetentionBatchWriteRow[],
): Promise<RetentionBatchAppliedRow[]> {
  if (rows.length === 0) return [];
  const values = sql.join(
    rows.map((row) => sql`(${row.id}, ${row.resultHash})`),
    sql`, `,
  );
  const result = await db.execute(sql`
    UPDATE heartbeat_runs AS h
    SET result_json = h.result_json || ${STDOUT_CAP_CASE} || ${STDERR_CAP_CASE}
    FROM (VALUES ${values}) AS v(id, hash)
    WHERE h.id = v.id::uuid
      AND md5(h.result_json::text) = v.hash
    RETURNING h.id AS id, octet_length(h.result_json::text) AS "resultBytes"
  `);
  return extractRows(result).map((row) => ({
    id: String(row.id),
    resultBytes: Number(row.resultBytes ?? 0),
  }));
}
