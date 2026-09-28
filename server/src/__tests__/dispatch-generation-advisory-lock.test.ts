// server/src/__tests__/dispatch-generation-advisory-lock.test.ts
//
// [B-7 비잠금 enqueue 창 폐쇄] resolveNextDispatchGeneration 이 count 직전에 잡는
// 앵커 단위 어드바이저리 트랜잭션 락(pg_advisory_xact_lock)의 계약 검증:
// (a) 트랜잭션 안에서 호출하면 같은 연결(pg_backend_pid)에 advisory 락이 보이고(≥1),
//     커밋 후에는 사라진다(=0) — count→insert 창이 tx 안에서 직렬화됨을 증명.
// (b) issue 앵커와 taskKey 앵커 두 경로 모두 락을 잡는다.
// (c) 0117 백스톱 부분 인덱스가 마이그레이션 적용 경로(applyPendingMigrations)에서 생성된다.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveNextDispatchGeneration } from "../services/effect-envelope.js";
import type { Db } from "@paperclipai/db";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function advisoryLockCount(db: Db, pid: number | null) {
  const rows = await db.execute(sql`
    select count(*)::int as count
    from pg_locks
    where locktype = 'advisory' and pid = ${pid ?? sql`pg_backend_pid()`}
  `);
  return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
}

describeEP("dispatch generation advisory transaction lock (B-7)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dispatch-gen-lock-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const anchorCases = [
    { label: "issue anchor", input: { agentId: "11111111-1111-1111-1111-111111111111", issueId: "22222222-2222-2222-2222-222222222222" } },
    { label: "taskKey anchor", input: { agentId: "11111111-1111-1111-1111-111111111111", taskKey: "dispatch-gen-lock-test-task" } },
  ] as const;

  for (const anchorCase of anchorCases) {
    it(`(${anchorCase.label}) holds an advisory xact lock inside the transaction and releases it after commit`, async () => {
      let backendPid: number | null = null;
      let inTxCount = -1;
      let generation = -1;
      await db.transaction(async (tx) => {
        const asDb = tx as unknown as Db;
        generation = await resolveNextDispatchGeneration(asDb, anchorCase.input);
        const pidRows = await tx.execute(sql`select pg_backend_pid() as pid`);
        backendPid = Number((pidRows[0] as { pid: number } | undefined)?.pid ?? 0);
        inTxCount = await advisoryLockCount(asDb, backendPid);
      });
      // 런 없는 앵커 → 첫 세대 1. 락은 트랜잭션 생애와 일치해야 한다.
      expect(generation).toBe(1);
      expect(inTxCount).toBeGreaterThanOrEqual(1);
      const afterCommitCount = await advisoryLockCount(db, backendPid);
      expect(afterCommitCount).toBe(0);
    });
  }

  it("(c) migration 0117 creates the shutdown-interrupted backstop partial index", async () => {
    const rows = await db.execute(sql`
      select count(*)::int as count
      from pg_indexes
      where indexname = 'heartbeat_runs_shutdown_interrupted_idx'
    `);
    expect(Number((rows[0] as { count: number } | undefined)?.count ?? 0)).toBe(1);
  });
});
