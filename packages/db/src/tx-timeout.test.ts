import { describe, expect, it } from "vitest";
import { TxTimeoutError, withTxTimeout } from "./tx-timeout.js";

type Tx = { marker: string };

function fakeTx(): Tx {
  return { marker: "tx" };
}

/**
 * 드리즐 node-postgres .transaction(cb) 시맨틱 최소 재현:
 * cb가 reject하면 ROLLBACK 후 재throw, resolve하면 COMMIT 경로.
 */
function fakeDb() {
  const events: string[] = [];
  const db = {
    events,
    async transaction<T>(cb: (tx: Tx) => Promise<T>): Promise<T> {
      const tx = fakeTx();
      try {
        const result = await cb(tx);
        events.push("commit");
        return result;
      } catch (err) {
        events.push("rollback");
        throw err;
      }
    },
  };
  return db;
}

describe("withTxTimeout", () => {
  it("정상 완료: 값 그대로 반환, 커밋 경로", async () => {
    const db = fakeDb();
    const out = await withTxTimeout<Tx, number>(db, async (tx) => {
      expect(tx.marker).toBe("tx");
      return 42;
    }, { timeoutMs: 500, label: "ok" });
    expect(out).toBe(42);
    expect(db.events).toEqual(["commit"]);
  });

  it("cb 비즈니스 에러: 원 에러 그대로 전파, 롤백 경로", async () => {
    const db = fakeDb();
    const boom = new Error("biz");
    await expect(
      withTxTimeout<Tx, never>(db, async () => { throw boom; }, { timeoutMs: 500, label: "err" }),
    ).rejects.toBe(boom);
    expect(db.events).toEqual(["rollback"]);
  });

  it("cb 행(hang): 타임아웃에 TxTimeoutError로 reject되고 트랜잭션은 롤백된다", async () => {
    const db = fakeDb();
    const start = Date.now();
    await expect(
      withTxTimeout<Tx, never>(db, () => new Promise<never>(() => {}), { timeoutMs: 30, label: "hang" }),
    ).rejects.toBeInstanceOf(TxTimeoutError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    expect(db.events).toEqual(["rollback"]);
  });

  it("에러 메시지에 라벨과 시간이 담긴다", async () => {
    const db = fakeDb();
    const p = withTxTimeout<Tx, never>(db, () => new Promise<never>(() => {}), { timeoutMs: 20, label: "heartbeat.claim" });
    await expect(p).rejects.toThrow(/tx timeout after 20ms \(heartbeat\.claim\)/);
  });

  it("타임아웃 타이머는 unref라 테스트 종료를 막지 않는다(도달 자체가 증명)", async () => {
    const db = fakeDb();
    await withTxTimeout<Tx, never>(db, () => new Promise<never>(() => {}), { timeoutMs: 10, label: "unref" })
      .catch(() => {});
    expect(true).toBe(true);
  });
});
