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
 *   UPDATE 는 조건부: 선별 시점의 result_json 해시(md5(result_json::text))와
 *   같을 때만 갱신해, 선별→갱신 사이에 재기록된 행은 건너뛴다(덮어쓰지 않음).
 * - 절단 표식: capHeartbeatRunResultJsonForStorage 와 동일(단일 소스 재사용).
 * - 주기: 하루 1회 이하(24h 간격, 기동 5분 후 첫 회). 프로세스 재시작이 같은 날
 *   스캔을 한 번 더 유발할 수 있으나 후보가 없으면 즉시 끝나는 멱등 스캔이다.
 * - 백업 보호: 패스 시작 시뿐 아니라 **배치마다** pg_dump(pg_stat_activity)·
 *   인앱 백업 flight 을 다시 확인해 도중 시작된 백업과 UPDATE 가 겹치지 않는다
 *   (계획 §3-3). 확인 자체가 실패하면 그 패스를 중단한다(fail-closed + 경고).
 * - 배치: 한 번에 200행씩 짧은 행 단위 UPDATE 로 처리한다(긴 트랜잭션 없음).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { capHeartbeatRunResultJsonForStorage } from "./heartbeat-run-summary.js";
import {
  defaultIsBackupActive,
  resolveRunOutputRetentionDays,
  resultJsonByteSize,
  selectRetentionCandidates,
} from "./heartbeat-run-output-retention-shared.js";

const RETENTION_BATCH_ROWS = 200;
// 사이클당 안전 밸브(200행 × 500배치 = 100,000행). 정상 운영은 훨씬 먼저 소진된다.
const RETENTION_MAX_BATCHES_PER_CYCLE = 500;

export const RUN_OUTPUT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RUN_OUTPUT_RETENTION_INITIAL_DELAY_MS = 5 * 60 * 1000;

export type RunOutputRetentionResult = {
  /**
   * "backup" 은 백업 활성(또는 확인 불가 — fail-closed)으로 패스가 시작 전
   * 건너뛰었거나 도중 중단됐음을 뜻한다. 도중 중단이면 이미 처리한
   * rowsTruncated/batches 는 그대로 남는다.
   */
  skipped: "disabled" | "spaced" | "backup" | null;
  rowsTruncated: number;
  bytesSaved: number;
  batches: number;
};

export type RunOutputRetentionOptions = {
  retentionDays: number;
  now?: () => Date;
  isBackupActive?: (db: Db) => Promise<boolean>;
  /** 배치당 행 수(기본 200). 시험용 튜닝 — 운영 경로는 기본값을 쓴다. */
  batchRows?: number;
};

/**
 * 보존 절단 1사이클. 멱등: 절단된 행은 길이 조건(>70,000)에서 다시 제외되므로
 * 두 번 돌려도 같은 결과(두 번째는 0행)가 된다.
 */
export async function runHeartbeatRunOutputRetention(
  db: Db,
  opts: RunOutputRetentionOptions,
): Promise<RunOutputRetentionResult> {
  const {
    retentionDays,
    now = () => new Date(),
    isBackupActive = defaultIsBackupActive,
    batchRows = RETENTION_BATCH_ROWS,
  } = opts;
  if (retentionDays < 1) {
    return { skipped: "disabled", rowsTruncated: 0, bytesSaved: 0, batches: 0 };
  }
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  let rowsTruncated = 0;
  let bytesSaved = 0;
  let batches = 0;
  for (;;) {
    // 배치마다 백업 실행 여부를 다시 확인한다. 확인 자체가 실패하면 확인 불가
    // 상태로 UPDATE 하지 않도록 그 패스를 중단한다(fail-closed).
    let backupActive: boolean;
    try {
      backupActive = await isBackupActive(db);
    } catch (err) {
      logger.warn(
        { err, batches, rowsTruncated },
        "Heartbeat run output retention: backup check failed; aborting pass (fail-closed)",
      );
      return { skipped: "backup", rowsTruncated, bytesSaved, batches };
    }
    if (backupActive) {
      if (batches === 0 && rowsTruncated === 0) {
        logger.info(
          { retentionDays },
          "Heartbeat run output retention: skipped while a database backup is running",
        );
      } else {
        logger.warn(
          { retentionDays, batches, rowsTruncated },
          "Heartbeat run output retention: aborting pass; a database backup started mid-cycle",
        );
      }
      return { skipped: "backup", rowsTruncated, bytesSaved, batches };
    }
    const candidates = await selectRetentionCandidates(db, cutoff, batchRows);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      const capped = capHeartbeatRunResultJsonForStorage(candidate.resultJson);
      // cap 함수는 미대상이면 동일 참조를 반환한다(방어 재확인).
      if (capped === candidate.resultJson) continue;
      const before = resultJsonByteSize(candidate.resultJson);
      const after = resultJsonByteSize(capped);
      // 조건부 UPDATE: 선별 시점 result_json 해시와 같을 때만 갱신한다.
      // 사이에 재기록된 행은 해시가 달라 0행이 갱신되고 건너뛴다.
      const applied = await db.update(heartbeatRuns)
        .set({ resultJson: capped })
        .where(and(
          eq(heartbeatRuns.id, candidate.id),
          sql`md5(${heartbeatRuns.resultJson}::text) = ${candidate.resultHash}`,
        ))
        .returning({ id: heartbeatRuns.id });
      if (applied.length === 0) {
        logger.info(
          { runId: candidate.id },
          "Heartbeat run output retention: row rewritten after selection; skipped",
        );
        continue;
      }
      rowsTruncated += 1;
      bytesSaved += Math.max(before - after, 0);
    }
    batches += 1;
    if (candidates.length < batchRows) break;
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

// split 이전 공개 표면 유지: 설정 해석·백업 탐지 심볼은 shared 파일의 단일
// 구현을 재수출한다(테스트·외부 참조가 같은 선언을 본다).
export {
  countPgDumpBackends,
  DEFAULT_RUN_OUTPUT_RETENTION_DAYS,
  defaultIsBackupActive,
  resolveRunOutputRetentionDays,
} from "./heartbeat-run-output-retention-shared.js";
export type { RunOutputRetentionSetting } from "./heartbeat-run-output-retention-shared.js";
