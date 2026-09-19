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
import { logger } from "../../middleware/logger.js";
import { executeWorkflowRun } from "./workflow-run-execution.js";

const TAG = "instant-advance";
/** dirty 연쇄 재진행 상한 — 1회 요청 체인이 유도할 수 있는 최대 연속 진행 횟수. */
const MAX_CONSECUTIVE_ADVANCES = 5;

/** DI 등록 — heartbeatService(db) 팩토리 시작 시 1회 호출. null 로 해제 가능(테스트). 미등록 요청은 no-op(warn). */
let configuredDb: Db | null = null;

export function configureInstantWorkflowAdvanceDb(db: Db | null): void {
  configuredDb = db;
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
    startAdvance(db, workflowRunId, 1);
  } catch (err) {
    logger.warn(
      { err, tag: TAG, workflowRunId },
      "failed to request instant workflow advance",
    );
  }
}

function startAdvance(db: Db, workflowRunId: string, chainCount: number): void {
  // 재진행 시작 시 dirty 해제 — 재진행 중에 다시 도착하는 요청만 다음 dirty 가 된다.
  // 연속 상한 검사는 settleAdvance 에서 체인을 넘기기 전에 한다(여기엔 항상 ≤ MAX 로만 온다).
  dirtyWorkflowRunIds.delete(workflowRunId);
  logger.info({ tag: TAG, workflowRunId, chainCount }, "advance start");
  const advance = (async () => {
    try {
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
    () => settleAdvance(db, workflowRunId, chainCount),
    () => settleAdvance(db, workflowRunId, chainCount),
  );
}

/** 진행 종료 정산 — map 정리/연쇄를 한 동기 블록에서 처리해 끼어들 틈을 주지 않는다. */
function settleAdvance(db: Db, workflowRunId: string, chainCount: number): void {
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
    startAdvance(db, workflowRunId, chainCount + 1);
    return;
  }
  inflightByWorkflowRunId.delete(workflowRunId);
}

/** 테스트 전용 — 모듈 상태 초기화. 프로덕션 코드는 호출 금지. */
export function resetInstantWorkflowAdvanceForTests(): void {
  inflightByWorkflowRunId.clear();
  dirtyWorkflowRunIds.clear();
}
