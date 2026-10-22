/**
 * [파일 목적] tool 스텝 종료 전이 시 toolQueue 메타데이터를 settled 로 정리하는 순수 헬퍼.
 *   완료/실패로 종료한 tool 스텝의 toolQueue.status 가 queued/claimed 로 남으면 resume 검사기·
 *   복구 뷰가 종료 행의 잔여를 계속 읽게 된다(2026-10-22 실측: 종료 행 4,751건 잔여, 이후에도
 *   계속 누적). 종료 전이에서 큐 기록을 settled 로 바꿔 잔여가 쌓이지 않게 한다.
 * [불변식]
 *   - toolQueue 기록이 없는 스텝(대기/큐 경유 없이 완료)에는 키를 새로 만들지 않는다.
 *     hasQueue 흔적 판정(resume stepFactsFor)이 없던 큐를 만들면 안 된다.
 *   - 순수 함수다 — DB/시계/파일 접근 없이 settledAt 만 주입받는다. 기존 toolQueue 의 다른
 *     필드(queuedAt/claimedAt/heartbeatRunId 등)는 원문 그대로 보존한다.
 */

export function settleToolQueueMetadata(
  metadata: Record<string, unknown>,
  settledAtIso: string,
): Record<string, unknown> {
  const toolQueue = metadata.toolQueue;
  if (typeof toolQueue !== "object" || toolQueue === null || Array.isArray(toolQueue)) {
    return metadata;
  }
  return {
    ...metadata,
    toolQueue: { ...(toolQueue as Record<string, unknown>), status: "settled", settledAt: settledAtIso },
  };
}
