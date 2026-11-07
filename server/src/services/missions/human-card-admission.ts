// [휴먼카드 남발 수리 2026-11-08] 사람 결정 카드 발행 자격(Admission) 판정.
// R1 계약: 자동 복구 가능한 원인(429/할당량, adapter_failed 재시도, stale/정산 미완,
// 자동 회수 가능한 issue_status_blocked)에는 사람 결정 카드를 발행하지 않는다.
// 판정은 원천(source) 이슈의 '마지막 terminal 런' 사실만 본다 — 추론·자연어 파싱 없음.
import { and, desc, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** 자동 복구 경로가 존재하는 error_code — 사람 카드 대신 재시도/정산 회수가 담당한다. */
export const AUTO_RECOVERABLE_RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  // adapter_failed: 429/속도제한/일시 adapter 장애 — heartbeat 재시도·폴백(enqueueProcessLossRetry 등)이 회수
  "adapter_failed",
  // stale_queued: 큐 승급 지연 — 감독 wakeup/재큐 경로가 회수
  "stale_queued",
  // issue_status_blocked: 런 취소 후 이슈 상태 정산 누락 — recoverTerminalUnsettledRuns 정산이 회수
  "issue_status_blocked",
]);

const TERMINAL_FAILURE_STATUSES = ["failed", "cancelled", "timed_out"] as const;

export type SourceTerminalRun = {
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly settledAt: Date | null;
};

export type HumanCardAdmission = {
  /** true = 사람 카드 발행 허용, false = 자동 복구 경로에 맡긴다(카드 없음). */
  readonly admit: boolean;
  readonly cause?: "auto_recoverable_error_code" | "settlement_pending";
  readonly runId?: string;
  readonly errorCode?: string | null;
};

/** 원천 이슈의 마지막 terminal 실패 런을 조회한다(실행 런은 원천 이슈에 붙는다). */
export async function loadSourceTerminalRun(
  db: Pick<Db, "select">,
  companyId: string,
  sourceIssueId: string,
): Promise<SourceTerminalRun | null> {
  const [run] = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    settledAt: heartbeatRuns.settledAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.issueId, sourceIssueId),
    inArray(heartbeatRuns.status, [...TERMINAL_FAILURE_STATUSES]),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  return run ?? null;
}

/**
 * 순수 판정 함수.
 * - 런 없음 → 발행 허용(자동 복구 대상이 없는 미지 원인은 사람 판단이 맞다).
 * - 자동 복구 가능 error_code → 거부.
 * - terminal 인데 정산 미완(settledAt null) → 거부(정산 회수가 source 를 풀어준다).
 * - 그 외(예: commandcode_permission_denied, 원인 미상 실패) → 발행 허용.
 */
export function evaluateHumanCardAdmission(run: SourceTerminalRun | null): HumanCardAdmission {
  if (!run) return { admit: true };
  if (run.errorCode && AUTO_RECOVERABLE_RUN_ERROR_CODES.has(run.errorCode)) {
    return { admit: false, cause: "auto_recoverable_error_code", runId: run.id, errorCode: run.errorCode };
  }
  if (run.settledAt == null) {
    return { admit: false, cause: "settlement_pending", runId: run.id, errorCode: run.errorCode };
  }
  return { admit: true };
}

/** 조회+판정 한 번의 헬퍼 — 카드 발행 경로(시스템 renewal, 에이전트 제출)에서 같은 기준을 쓴다. */
export async function admitHumanCardForSource(
  db: Pick<Db, "select">,
  companyId: string,
  sourceIssueId: string,
): Promise<HumanCardAdmission> {
  return evaluateHumanCardAdmission(await loadSourceTerminalRun(db, companyId, sourceIssueId));
}
