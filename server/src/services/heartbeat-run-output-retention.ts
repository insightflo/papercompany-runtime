/**
 * Heartbeat run 출력 보존 절단 주기 작업
 *
 * [보존 절단 2026-11-09 승인] 보존일을 넘은 종결 실행의 heartbeat_runs.result_json
 * stdout/stderr 를 신규 행 저장 계약(heartbeat-run-summary.ts — 앞/뒌 32KB + 절단
 * 표식)과 완전히 같은 형식으로 절단해 DB 페이로드와 백업 시간을 줄인다
 * (a1-opt-plan.md §3 정책 A). 절단은 비가역이며 원문은 run-log 파일에만 남는다.
 *
 * 계약:
 * - 대상: created_at 이 보존일(기본 7일, PAPERCLIP_RUN_OUTPUT_RETENTION_DAYS)을
 *   넘었고, status 가 종결 상태(succeeded/failed/cancelled/timed_out)이며,
 *   v1 종결화가 진행 중(finalization_version>0 & settled_at IS NULL)이 아닌 행.
 *   진행 중(queued/running)·미정산 실행은 절대 건드리지 않는다.
 * - 갱신: result_json 만. status·updated_at 등 다른 컬럼은 변경하지 않는다.
 * - 절단 표식: capHeartbeatRunResultJsonForStorage 와 동일(단일 소스 재사용).
 * - 주기: 하루 1회 이하(24h 간격, 기동 5분 후 첫 회). 프로세스 재시작이 같은 날
 *   스캔을 한 번 더 유발할 수 있으나 후보가 없으면 즉시 끝나는 멱등 스캔이다.
 * - 백업 보호: pg_dump(pg_stat_activity) 또는 인앱 백업 flight 실행 중에는
 *   건너뛴다(계획 §3-3: 백업과 동시 UPDATE 금지).
 * - 배치: 한 번에 200행씩 짧은 행 단위 UPDATE 로 처리한다(긴 트랜잭션 없음).
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { capHeartbeatRunResultJsonForStorage, STORED_OUTPUT_TRUNCATE_THRESHOLD } from "./heartbeat-run-summary.js";
import { TERMINAL_HEARTBEAT_RUN_STATUS_VALUES } from "./heartbeat-run-status.js";
import { isDatabaseBackupFlightActive } from "./database-backup-flight-state.js";

export const DEFAULT_RUN_OUTPUT_RETENTION_DAYS = 7;

const RETENTION_BATCH_ROWS = 200;
// 사이클당 안전 밸브(200행 × 500배치 = 100,000행). 정상 운영은 훨씬 먼저 소진된다.
const RETENTION_MAX_BATCHES_PER_CYCLE = 500;

export const RUN_OUTPUT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RUN_OUTPUT_RETENTION_INITIAL_DELAY_MS = 5 * 60 * 1000;

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

function extractRows(result: unknown): Record<string, unknown>[] {
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

async function defaultIsBackupActive(db: Db): Promise<boolean> {
  if (isDatabaseBackupFlightActive()) return true;
  try {
    return (await countPgDumpBackends(db)) > 0;
  } catch (err) {
    // 가시성 권한 등으로 조회 자체가 실패한 경우: 이 확인은 보호 계층이며, 배포
    // 시퀀스(백업 → 재시작 → 5분 후 첫 회)가 이미 충돌을 회피하므로 진행한다.
    logger.warn({ err }, "Heartbeat run output retention: pg_stat_activity backup check failed; proceeding");
    return false;
  }
}

type RetentionCandidate = {
  id: string;
  resultJson: Record<string, unknown>;
};

async function selectRetentionCandidates(db: Db, cutoff: Date, limit: number): Promise<RetentionCandidate[]> {
  const statuses = sql.join(
    TERMINAL_HEARTBEAT_RUN_STATUS_VALUES.map((status) => sql`${status}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT h.id AS id, h.result_json AS "resultJson"
    FROM heartbeat_runs h
    WHERE h.created_at < ${cutoff.toISOString()}::timestamptz
      AND h.status IN (${statuses})
      AND NOT (h.finalization_version > 0 AND h.settled_at IS NULL)
      AND jsonb_typeof(h.result_json) = 'object'
      AND (length(h.result_json->>'stdout') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD}
        OR length(h.result_json->>'stderr') > ${STORED_OUTPUT_TRUNCATE_THRESHOLD})
    ORDER BY h.created_at
    LIMIT ${limit}
  `);
  return extractRows(result).map((row) => ({
    id: String(row.id),
    resultJson: (row.resultJson ?? {}) as Record<string, unknown>,
  }));
}

function resultJsonByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

export type RunOutputRetentionResult = {
  skipped: "disabled" | "spaced" | "backup" | null;
  rowsTruncated: number;
  bytesSaved: number;
  batches: number;
};

export type RunOutputRetentionOptions = {
  retentionDays: number;
  now?: () => Date;
  isBackupActive?: (db: Db) => Promise<boolean>;
};

/**
 * 보존 절단 1사이클. 멱등: 절단된 행은 길이 조건(>70,000)에서 다시 제외되므로
 * 두 번 돌려도 같은 결과(두 번째는 0행)가 된다.
 */
export async function runHeartbeatRunOutputRetention(
  db: Db,
  opts: RunOutputRetentionOptions,
): Promise<RunOutputRetentionResult> {
  const { retentionDays, now = () => new Date(), isBackupActive = defaultIsBackupActive } = opts;
  if (retentionDays < 1) {
    return { skipped: "disabled", rowsTruncated: 0, bytesSaved: 0, batches: 0 };
  }
  if (await isBackupActive(db)) {
    logger.info(
      { retentionDays },
      "Heartbeat run output retention: skipped while a database backup is running",
    );
    return { skipped: "backup", rowsTruncated: 0, bytesSaved: 0, batches: 0 };
  }
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  let rowsTruncated = 0;
  let bytesSaved = 0;
  let batches = 0;
  for (;;) {
    const candidates = await selectRetentionCandidates(db, cutoff, RETENTION_BATCH_ROWS);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      const capped = capHeartbeatRunResultJsonForStorage(candidate.resultJson);
      // cap 함수는 미대상이면 동일 참조를 반환한다(방어 재확인).
      if (capped === candidate.resultJson) continue;
      const before = resultJsonByteSize(candidate.resultJson);
      const after = resultJsonByteSize(capped);
      await db.update(heartbeatRuns)
        .set({ resultJson: capped })
        .where(eq(heartbeatRuns.id, candidate.id));
      rowsTruncated += 1;
      bytesSaved += Math.max(before - after, 0);
    }
    batches += 1;
    if (candidates.length < RETENTION_BATCH_ROWS) break;
    if (batches >= RETENTION_MAX_BATCHES_PER_CYCLE) {
      logger.warn(
        { batches, rowsTruncated },
        "Heartbeat run output retention: hit per-cycle batch cap; remaining rows continue next cycle",
      );
      break;
    }
  }
  logger.info(
    { rowsTruncated, bytesSaved, batches, retentionDays },
    "Heartbeat run output retention: pass complete",
  );
  return { skipped: null, rowsTruncated, bytesSaved, batches };
}

export function createHeartbeatRunOutputRetentionJob(
  db: Db,
  opts: {
    envRaw?: string;
    intervalMs?: number;
    initialDelayMs?: number;
    isBackupActive?: (db: Db) => Promise<boolean>;
    now?: () => Date;
  } = {},
) {
  const intervalMs = opts.intervalMs ?? RUN_OUTPUT_RETENTION_INTERVAL_MS;
  const initialDelayMs = opts.initialDelayMs ?? RUN_OUTPUT_RETENTION_INITIAL_DELAY_MS;
  const setting = resolveRunOutputRetentionDays(
    opts.envRaw ?? process.env.PAPERCLIP_RUN_OUTPUT_RETENTION_DAYS,
    (reason) => logger.warn(reason),
  );
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let lastRunAt: number | null = null;
  const activeRuns = new Set<Promise<void>>();

  function trackRun(promise: Promise<unknown>): Promise<void> {
    const tracked = promise.then(() => undefined, () => undefined);
    activeRuns.add(tracked);
    void tracked.then(() => activeRuns.delete(tracked), () => activeRuns.delete(tracked));
    return tracked;
  }

  async function runPass(): Promise<RunOutputRetentionResult> {
    if (!setting.enabled) {
      return { skipped: "disabled", rowsTruncated: 0, bytesSaved: 0, batches: 0 };
    }
    // 같은 프로세스에서 중복 start()·착오로 인한 과다 실행 방지
    // (하루 1회 이하 계약의 프로세스 내 보장). 프로세스 재시작 후에는 메모리가
    // 초기화되어 한 번 더 멱등 스캔이 돌 수 있다(후보 0건이면 즉시 종료).
    if (lastRunAt !== null && Date.now() - lastRunAt < intervalMs) {
      return { skipped: "spaced", rowsTruncated: 0, bytesSaved: 0, batches: 0 };
    }
    lastRunAt = Date.now();
    try {
      return await runHeartbeatRunOutputRetention(db, {
        retentionDays: setting.days,
        isBackupActive: opts.isBackupActive,
        now: opts.now,
      });
    } catch (err) {
      logger.error({ err }, "Heartbeat run output retention: failed");
      return { skipped: null, rowsTruncated: 0, bytesSaved: 0, batches: 0 };
    }
  }

  function start(): void {
    if (!setting.enabled) {
      logger.info(
        { env: "PAPERCLIP_RUN_OUTPUT_RETENTION_DAYS" },
        "Heartbeat run output retention: disabled by configuration",
      );
      return;
    }
    if (intervalTimer || initialTimer) return;
    logger.info(
      { retentionDays: setting.days, intervalHours: Math.round(intervalMs / 3_600_000) },
      "Heartbeat run output retention: enabled",
    );
    const currentGeneration = ++generation;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      if (currentGeneration !== generation) return;
      void trackRun(runPass());
      intervalTimer = setInterval(() => {
        if (currentGeneration !== generation) return;
        void trackRun(runPass());
      }, intervalMs);
    }, initialDelayMs);
  }

  function stop(): void {
    generation += 1;
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function drain(): Promise<void> {
    return Promise.all([...activeRuns]).then(() => {});
  }

  return { start, stop, drain, runPass, setting };
}
