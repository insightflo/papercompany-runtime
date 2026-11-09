/**
 * Heartbeat run 출력 보존 절단 — 설정 해석·후보 선별·백업 탐지 계층
 *
 * heartbeat-run-output-retention.ts 의 절단 사이클/스케줄이 이 파일의 순수
 * 조회 함수들을 사용한다(쓰기는 …-retention-write.ts 의 UPDATE 뿐 —
 * write-chokepoint 가드의 DATA 허용 목록에도 그 파일만 등록한다).
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { STORED_OUTPUT_TRUNCATE_THRESHOLD } from "./heartbeat-run-summary.js";
import { TERMINAL_HEARTBEAT_RUN_STATUS_VALUES } from "./heartbeat-run-status.js";
import { isDatabaseBackupFlightActive } from "./database-backup-flight-state.js";

export const DEFAULT_RUN_OUTPUT_RETENTION_DAYS = 7;

export type RunOutputRetentionSetting = {
  enabled: boolean;
  days: number;
};

/**
 * PAPERCLIP_RUN_OUTPUT_RETENTION_DAYS 해석.
 * - 미설정 → 기본 7일(활성).
 * - '0'·'off'·'false'(대소문자 무관) → 비활성.
 * - 숫자 1 이상 → 정수로 절사해 사용.
 * - 숫자 아님·1 미만(0 제외) → 기본 7일 + 경고(onInvalid 1회).
 */
export function resolveRunOutputRetentionDays(
  raw: string | undefined,
  onInvalid?: (reason: string) => void,
): RunOutputRetentionSetting {
  const text = (raw ?? "").trim();
  if (text === "") return { enabled: true, days: DEFAULT_RUN_OUTPUT_RETENTION_DAYS };
  const lowered = text.toLowerCase();
  if (text === "0" || lowered === "off" || lowered === "false") {
    return { enabled: false, days: DEFAULT_RUN_OUTPUT_RETENTION_DAYS };
  }
  const parsed = Number(text);
  if (Number.isFinite(parsed) && parsed === 0) {
    return { enabled: false, days: DEFAULT_RUN_OUTPUT_RETENTION_DAYS };
  }
  if (!Number.isFinite(parsed) || parsed < 1) {
    onInvalid?.(
      `Invalid PAPERCLIP_RUN_OUTPUT_RETENTION_DAYS '${text}'; ` +
        `falling back to default ${DEFAULT_RUN_OUTPUT_RETENTION_DAYS} days`,
    );
    return { enabled: true, days: DEFAULT_RUN_OUTPUT_RETENTION_DAYS };
  }
  return { enabled: true, days: Math.trunc(parsed) };
}

export function extractRows(result: unknown): Record<string, unknown>[] {
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows
    ?? (result as unknown as Record<string, unknown>[] | undefined);
  return Array.isArray(rows) ? rows : [];
}

/**
 * pg_stat_activity 에서 이 DB 로 접속 중인 pg_dump 백엔드 수.
 * 외부 백업(A1 systemd papercompany-db-backup.service 등) 탐지용.
 * application_name 은 PostgreSQL 10+ 에서 모든 역할에게 보인다.
 */
export async function countPgDumpBackends(db: Db): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM pg_stat_activity
    WHERE application_name LIKE 'pg_dump%'
  `);
  const rows = extractRows(result);
  return Number(rows[0]?.n ?? 0);
}

/**
 * 기본 백업 활성 판정: 인앱 백업 flight 또는 pg_stat_activity 의 pg_dump 백엔드.
 * pg_stat_activity 조회가 실패하면 fail-closed — 백업 여부를 알 수 없는 상태로
 * UPDATE 를 진행하지 않도록 "활성" 으로 취급한다(경고 로그 + 그 패스 중단).
 */
export async function defaultIsBackupActive(db: Db): Promise<boolean> {
  if (isDatabaseBackupFlightActive()) return true;
  try {
    return (await countPgDumpBackends(db)) > 0;
  } catch (err) {
    logger.warn(
      { err },
      "Heartbeat run output retention: pg_stat_activity backup check failed; treating backup as active (fail-closed)",
    );
    return true;
  }
}

export type RetentionCandidate = {
  id: string;
  /** 선별 시점 result_json::text 의 md5 — 조건부 UPDATE 의 CAS 조건으로 사용. */
  resultHash: string;
  /** 선별 시점 result_json::text 의 octet_length — 배치 바이트 상한·bytesSaved 계산용. */
  resultBytes: number;
};

/**
 * 후보 선별 — [OOM 수리] result_json 본문은 가져오지 않고 id·md5·바이트 길이만
 * 반환한다(행당 수 MB × 배치 수백 행이 Node 힙에 파싱·보유되던 경로 차단).
 * 절단은 …-retention-write.ts 의 UPDATE 가 DB 안에서 수행한다.
 * excludedIds 는 같은 사이클 안에서 CAS 불일치로 건너뛴 행 — 다음 선별에서
 * 제외해 가장 오래된 행이 계속 재선택되는 정체를 막는다.
 */
export async function selectRetentionCandidates(
  db: Db,
  cutoff: Date,
  limit: number,
  excludedIds: readonly string[] = [],
): Promise<RetentionCandidate[]> {
  const statuses = sql.join(
    TERMINAL_HEARTBEAT_RUN_STATUS_VALUES.map((status) => sql`${status}`),
    sql`, `,
  );
  const exclusion = excludedIds.length === 0
    ? sql``
    : sql`AND NOT (h.id = ANY(ARRAY[${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]))`;
  const result = await db.execute(sql`
    SELECT h.id AS id,
      md5(h.result_json::text) AS "resultHash",
      octet_length(h.result_json::text) AS "resultBytes"
    FROM heartbeat_runs h
    WHERE h.created_at < ${cutoff.toISOString()}::timestamptz
      AND h.status IN (${statuses})
      AND NOT (h.finalization_version > 0 AND h.settled_at IS NULL)
      AND jsonb_typeof(h.result_json) = 'object'
      AND (length(h.result_json->>'stdout') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD}
        OR length(h.result_json->>'stderr') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD})
      ${exclusion}
    ORDER BY h.created_at
    LIMIT ${limit}
  `);
  return extractRows(result).map((row) => ({
    id: String(row.id),
    resultHash: String(row.resultHash ?? ""),
    resultBytes: Number(row.resultBytes ?? 0),
  }));
}
