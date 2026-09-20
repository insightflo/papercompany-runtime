// server/src/services/workflow/instant-advance.ts
//
// [purpose] 하트비트 가속 v1.2 — 에이전트 런(어댑터 실행)의 종말 확정 직후, 워크플로우 재평가를
//   다음 하트비트/스케줄러 틱까지 미루지 않고 즉시 요청한다. 평가는 기존 공개 경로
//   executeWorkflowRun(db, runId) 을 그대로 재사용한다(별도 평가 로직 금지 — 권위는 동일한
//   내구 레코드 읽기). 게이트 PAPERCLIP_WORKFLOW_INSTANT_ADVANCE("1"/"true")는 기본 off:
//   게이트 off 면 no-op 이다. fire-and-forget — 호출자(heartbeat 런 종결 경로)를 절대
//   차단하거나 실패시키지 않는다.
// [authority] 이 모듈은 트리거일 뿐 상태를 소유하지 않는다(규칙 7/8). 진행 성공/실패 판정은
//   executeWorkflowRun 의 내구 레코드 쓰기에만 있다. 실패는 짧은 warn 로그만 남기고, 주기
//   하트비트/스케줄러 틱이 폴백이다.
// [합치기 계약] per-run 진행 락(Map<workflowRunId, Promise>) + dirty Set. 진행 중 도착한
//   요청은 dirty 로 표시되고 버려지지 않는다. 진행 종료 시 dirty 면 1회 재진행(then 체인,
//   동기 재귀 아님). 재진행 시작 시 dirty 를 해제해, 재진행 중에 다시 오는 요청만 다음
//   dirty 가 된다. 연속 진행 상한(기본 5회/요청 체인)으로 dirty 무한 루프를 차단한다.
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { isRunReopenGuardEnabled, RUN_REOPEN_TERMINAL_STATUSES } from "./run-reopen-guard-flag.js";
import { executeWorkflowRun } from "./workflow-run-execution.js";

const TAG = "instant-advance";
/** dirty 연쇄 재진행 상한 — 1회 요청 체인이 유도할 수 있는 최대 연속 진행 횟수. */
const MAX_CONSECUTIVE_ADVANCES = 5;

/** DI 등록 — heartbeatService(db) 팩토리 시작 시 1회 호출. null 로 해제 가능(테스트). 미등록 요청은 no-op(warn). */
let configuredDb: Db | null = null;

// [run-reopen-guard v1] 주입 시점 1회 플래그 판정(요청당 재판정 없음). true/false 는 확정값,
// null 은 판정 경합 중 — 이 경우 요청이 실패닫힌 비동기 판정 경로로 진입한다. 판정 실패는
// 플래그 off 로 취급해 fire-and-forget 트리거가 깨지지 않는다(기존 틱 폴백 유지).
let reopenGuardEnabledCache: boolean | null = null;
let reopenGuardJudgement: Promise<boolean> | null = null;
let reopenGuardVerdictToken: symbol | null = null;

export function configureInstantWorkflowAdvanceDb(db: Db | null): void {
  configuredDb = db;
  reopenGuardEnabledCache = null;
  applyReopenGuardVerdict(db ? isRunReopenGuardEnabled(db) : Promise.resolve(false));
}

/** [봇 지적 교정] 판정 실패는 이번 한 번만 off 로 취급(동기 계약 유지)하고 판정을 비워
 *   다음 요청이 다시 읽게 한다 — 재시작 전까지 영구 off(fail-open 고착)가 되지 않는다.
 *   재호출 시 낡은 Promise 가 캐시를 덮어쓰지 않게 토큰으로 선별한다. */
function applyReopenGuardVerdict(judgement: Promise<boolean>): void {
  const token = Symbol("instant-advance-guard-verdict");
  reopenGuardVerdictToken = token;
  reopenGuardJudgement = judgement;
  void judgement.then(
    (enabled) => {
      if (reopenGuardVerdictToken === token) reopenGuardEnabledCache = enabled;
    },
    () => {
      if (reopenGuardVerdictToken !== token) return;
      reopenGuardEnabledCache = false;
      reopenGuardJudgement = null;
    },
  );
}

/** 게이트 판정 — 호출마다 process.env 를 다시 읽는다(테스트/런타임 토글 가능). */
export function isInstantWorkflowAdvanceEnabled(): boolean {
  const raw = process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE;
  return raw === "1" || raw === "true";
}

const inflightByWorkflowRunId = new Map<string, Promise<void>>();
const dirtyWorkflowRunIds = new Set<string>();

/**
 * 워크플로우 즉시 진행 요청 — fire-and-forget. 게이트 off / 미등록 db 면 no-op.
 * 진행 중이면 dirty 로 합쳐지고, 종료 시 최대 MAX_CONSECUTIVE_ADVANCES 회까지 재진행된다.
 * 이 함수는 절대 throw 하지 않는다(호출부는 heartbeat 런 종결 경로).
 */
export function requestInstantWorkflowAdvance(workflowRunId: string): void {
  try {
    if (!isInstantWorkflowAdvanceEnabled()) return;
    const db = configuredDb;
    if (!db) {
      logger.warn(
        { tag: TAG, workflowRunId },
        "instant advance requested before db configuration — skipping",
      );
      return;
    }
    if (inflightByWorkflowRunId.has(workflowRunId)) {
      dirtyWorkflowRunIds.add(workflowRunId);
      logger.info(
        { tag: TAG, workflowRunId },
        "advance already in flight — request coalesced as dirty",
      );
      return;
    }
    if (reopenGuardEnabledCache === false) {
      // 플래그 off 확정 — 기존 동기 경로 그대로(신규 I/O 없음). 단 판정 "실패로 인한 off" 라면
      // (judgement 가 null 로 비워져 있으면) 다음 요청의 회복을 위해 비동기 재판정만 걸어둔다.
      if (reopenGuardJudgement === null && configuredDb) {
        applyReopenGuardVerdict(isRunReopenGuardEnabled(configuredDb));
      }
      startAdvance(db, workflowRunId, 1, false);
      return;
    }
    // 플래그 on(또는 판정 경합) — 종결 run 은 평가 자체를 스킵한다(실패닫힘).
    // [봇 지적 교정] advanceIfNotTerminal 은 async — void 호출의 rejection 을 여기서 흡수해야
    //   트리거 계약("이 함수는 절대 throw 하지 않는다")이 유지된다(비동기 rejection 은 동기
    //   try/catch 로 잡히지 않고 프로세스를 죽일 수 있다).
    advanceIfNotTerminal(db, workflowRunId).catch((err) => {
      logger.warn(
        { err, tag: TAG, workflowRunId },
        "instant advance terminal-check failed — falling back to heartbeat tick",
      );
    });
  } catch (err) {
    logger.warn(
      { err, tag: TAG, workflowRunId },
      "failed to request instant workflow advance",
    );
  }
}

/**
 * [run-reopen-guard v1] 종결 판정 후 진행 — 평가 직전 run 상태 1회 SELECT 로 종결
 * (completed/cancelled/aborted/failed/timed-out) run 을 스킵한다. 재계산 부활 경로로의 재진입을
 * 막는 트리거 측 가드이며, 공식 재개는 회복 경로(PR-2b)의 소관이다.
 */
async function advanceIfNotTerminal(db: Db, workflowRunId: string): Promise<void> {
  const guardEnabled = reopenGuardEnabledCache
    ?? await (reopenGuardJudgement ?? Promise.resolve(false));
  if (inflightByWorkflowRunId.has(workflowRunId)) {
    dirtyWorkflowRunIds.add(workflowRunId);
    return;
  }
  if (!guardEnabled) {
    startAdvance(db, workflowRunId, 1, false);
    return;
  }
  if (await isTerminalRunForInstantAdvance(db, workflowRunId)) {
    logger.debug(
      { tag: TAG, workflowRunId },
      "terminal run — instant advance skipped (reopen requires the official recovery path)",
    );
    return;
  }
  if (inflightByWorkflowRunId.has(workflowRunId)) {
    dirtyWorkflowRunIds.add(workflowRunId);
    return;
  }
  startAdvance(db, workflowRunId, 1, true);
}

async function isTerminalRunForInstantAdvance(db: Db, workflowRunId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, workflowRunId))
    .limit(1);
  return row ? RUN_REOPEN_TERMINAL_STATUSES.has(row.status) : false;
}

function startAdvance(db: Db, workflowRunId: string, chainCount: number, reopenGuardEnabled: boolean): void {
  // 재진행 시작 시 dirty 해제 — 재진행 중에 다시 도착하는 요청만 다음 dirty 가 된다.
  // 연속 상한 검사는 settleAdvance 에서 체인을 넘기기 전에 한다(여기엔 항상 ≤ MAX 로만 온다).
  dirtyWorkflowRunIds.delete(workflowRunId);
  logger.info({ tag: TAG, workflowRunId, chainCount }, "advance start");
  const advance = (async () => {
    try {
      // [run-reopen-guard v1] 평가 직전 종결 판정 — dirty 체인의 재진행도 같은 위치에서 차단된다.
      if (reopenGuardEnabled && (await isTerminalRunForInstantAdvance(db, workflowRunId))) {
        logger.debug(
          { tag: TAG, workflowRunId, chainCount },
          "terminal run — instant advance skipped (reopen requires the official recovery path)",
        );
        return;
      }
      await executeWorkflowRun(db, workflowRunId);
      logger.info({ tag: TAG, workflowRunId, chainCount }, "advance finished");
    } catch (err) {
      // 진행 실패는 로그만 — 주기 틱이 폴백이다(재발사/보상 로직 없음).
      logger.warn(
        { err, tag: TAG, workflowRunId, chainCount },
        "advance failed — heartbeat tick is the fallback",
      );
    }
  })();
  inflightByWorkflowRunId.set(workflowRunId, advance);
  void advance.then(
    () => settleAdvance(db, workflowRunId, chainCount, reopenGuardEnabled),
    () => settleAdvance(db, workflowRunId, chainCount, reopenGuardEnabled),
  );
}

/** 진행 종료 정산 — map 정리/연쇄를 한 동기 블록에서 처리해 끼어들 틈을 주지 않는다. */
function settleAdvance(db: Db, workflowRunId: string, chainCount: number, reopenGuardEnabled: boolean): void {
  if (dirtyWorkflowRunIds.has(workflowRunId)) {
    if (chainCount + 1 > MAX_CONSECUTIVE_ADVANCES) {
      // 상한 도달 — dirty 체인 중단·경고. 상태를 정리해 이후 요청이 새 체인(카운터 초기화)으로
      // 시작할 수 있게 한다(모듈 메모리에 영구 inflight 잔류 방지).
      logger.warn(
        { tag: TAG, workflowRunId, chainCount, cap: MAX_CONSECUTIVE_ADVANCES },
        "consecutive advance cap reached — stopping dirty chain (heartbeat tick remains the fallback)",
      );
      dirtyWorkflowRunIds.delete(workflowRunId);
      inflightByWorkflowRunId.delete(workflowRunId);
      return;
    }
    logger.info(
      { tag: TAG, workflowRunId, chainCount },
      "dirty request pending — chaining one more advance",
    );
    startAdvance(db, workflowRunId, chainCount + 1, reopenGuardEnabled);
    return;
  }
  inflightByWorkflowRunId.delete(workflowRunId);
}

/** 테스트 전용 — 모듈 상태 초기화. 프로덕션 코드는 호출 금지. */
export function resetInstantWorkflowAdvanceForTests(): void {
  inflightByWorkflowRunId.clear();
  dirtyWorkflowRunIds.clear();
}

/** 테스트 전용 — 주입 시점 reopen-guard 플래그 판정 대기. 프로덕션 코드는 호출 금지. */
export function reopenGuardJudgementForTests(): Promise<boolean> | null {
  return reopenGuardJudgement;
}
