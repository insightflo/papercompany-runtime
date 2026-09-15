/**
 * withTxTimeout — db.transaction 콜백이 영영 settle하지 않는 사고로부터
 * 서비스를 보호하는 레이스 타임아웃 래퍼.
 *
 * 배경(2026-09-15 A1 장애 2건, 실측): 어떤 트랜잭션 콜백이 끝나지 않으면
 * 커밋도 롤백도 전송되지 않고, 그 연결은 "idle in transaction"으로 행 잠금을
 * 쥔 채 방치된다. 같은 행을 건드리는 나머지 풀 연결이 전부 잠금 대기로 막히면서
 * API 전체가 응답 불능이 되었다(서버 프로세스는 epoll 대기 중 'running').
 *
 * 동작: 콜백을 타임아웃 프라미스와 레이스한다. 시간 내 완료/실패는 그대로
 * 드리즐 시맨틱을 따르고, 시간 초과면 TxTimeoutError로 reject한다 — 콜백의
 * reject는 드리즐이 ROLLBACK으로 이어받는다(연결이 idle 상태일 때 즉시 롤백,
 * 쿼리가 막혀 있으면 DB 측 lock_timeout/idle_in_transaction_session_timeout이
 * 최종 백스톱). 타이머는 unref라 프로세스를 붙잡지 않는다.
 */

export class TxTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`tx timeout after ${timeoutMs}ms (${label}) — transaction rolled back; the callback likely hangs on a non-DB await`);
    this.name = "TxTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export const DEFAULT_TX_TIMEOUT_MS = 30_000;

type TransactionFn<TDb, T> = (db: TDb) => Promise<T>;

/** 구조적 최소 요구: 드리즐 node-postgres db.transaction과 호환. */
type HasTransaction<TTx> = {
  transaction<T>(cb: (tx: TTx) => Promise<T>): Promise<T>;
};

export async function withTxTimeout<TTx, T>(
  db: HasTransaction<TTx>,
  fn: (tx: TTx) => Promise<T>,
  opts?: { timeoutMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
  const label = opts?.label ?? "unnamed";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TxTimeoutError(label, timeoutMs)), timeoutMs);
    // 타임아웃 타이머가 프로세스 종료/이벤트 루프를 붙잡지 않게 한다.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await db.transaction(async (tx: TTx) => Promise.race([fn(tx), timeout]));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
