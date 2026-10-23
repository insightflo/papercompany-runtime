// [파일 목적] 취소 테스트의 잠금 관찰과 수동 해제 장벽을 공유한다.
// [주요 흐름] 테스트 소유 잠금의 PID를 얻고 실제 blocker 관계를 관찰한 뒤 gate로 해제한다.
// [외부 연결] PostgreSQL pg_stat_activity/pg_blocking_pids, quality fixture.
// [수정시 주의] SQL 문구는 증거가 아니다. 호출자가 통제한 시작 순서와 PID 관계로 lane을 식별한다.
import { sql } from "drizzle-orm";
import { agentRuntimeState, type Db } from "@paperclipai/db";
import type { QualityFixture } from "./quality-fixture.js";

/** 조건 폴링(마감 있는 condition wait) — 고정 sleep 을 증거로 쓰지 않는다. */
export async function pollUntil(deadlineMs: number, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await probe();
}

type BlockedBackend = { pid: number; query: string; blockers: number[] };

/** 실제 잠금 대기만 읽는다. query는 실패 진단용이며 선택 조건에는 노출하지 않는다. */
async function readBlockedBackends(db: Db): Promise<BlockedBackend[]> {
  return (await db.execute(sql`
    select pid, query, pg_blocking_pids(pid) as blockers
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and state = 'active' and wait_event_type = 'Lock'
      and cardinality(pg_blocking_pids(pid)) > 0
  `)) as unknown as BlockedBackend[];
}

/** 특정 holder pid 를 막은 대기 backend 수 — 실제 잠금 대기 관찰(pg_blocking_pids). */
export async function countWaitersBlockedBy(db: Db, holderPid: number): Promise<number> {
  return (await readBlockedBackends(db)).filter(row => row.blockers.includes(holderPid)).length;
}

/** holder 뒤의 직접 대기자와 한 단계 간접 대기자를 중복 없이 센다. */
export async function countLockQueueBehind(db: Db, holderPid: number): Promise<number> {
  const rows = await readBlockedBackends(db);
  return rows.filter(row => row.blockers.includes(holderPid)
    || rows.some(blocker => row.blockers.includes(blocker.pid) && blocker.blockers.includes(holderPid))).length;
}

/** [목적] 알려진 holder 뒤의 lane을 실제 PID 관계로 찾는다.
 * [입력] blockedByPid는 직접 blocker, waiterPid는 이미 관찰한 대기자(선택).
 * blockerBlockedByPid가 있으면 같은 관찰에서 waiter → blocker → root 연결을 요구한다.
 * [출력] 관찰한 대기자 또는 마감 시 null. [연결] pg_stat_activity/pg_blocking_pids.
 * [주의] lane 이름은 호출자가 통제한 시작 순서로만 부여한다. SQL은 진단 출력 전용이다.
 * [수정시 영향] 두 부여 순서의 직렬 대기 증명. */
export async function pollBlockedBackend(
  db: Db,
  lane: { blockedByPid: number; waiterPid?: number; blockerBlockedByPid?: number; excludePids?: number[] },
  deadlineMs = 20_000,
): Promise<BlockedBackend | null> {
  let found: BlockedBackend | null = null;
  let observed: BlockedBackend[] = [];
  const ok = await pollUntil(deadlineMs, async () => {
    observed = await readBlockedBackends(db);
    const chainPresent = lane.blockerBlockedByPid === undefined || observed.some(row =>
      row.pid === lane.blockedByPid && row.blockers.includes(lane.blockerBlockedByPid!));
    found = chainPresent ? observed.find(row => row.blockers.includes(lane.blockedByPid)
      && (lane.waiterPid === undefined || row.pid === lane.waiterPid)
      && !lane.excludePids?.includes(row.pid)) ?? null : null;
    return found !== null;
  });
  if (!ok) console.error("[quality-cancel-locks] missing PID lane:", JSON.stringify({ lane, observed }));
  return ok ? found : null;
}

/** [barrier] agent_runtime_state PK 투기적 INSERT — 러너의 세팅 ensureRuntimeState INSERT(claim 이후,
 * 어댑터 이전)이 이 트랜잭션이 결정될 때까지 결정론적으로 주차된다. 해제 모드는 gate 로 나중에 정한다. */
export async function parkRunnerInSetupBarrier(db: Db, seeded: QualityFixture) {
  const gate = { settle: (_mode: "commit" | "rollback") => {} };
  let holderPid = 0;
  let assigned = false;
  const settled = db.transaction(async (tx) => {
    await tx.insert(agentRuntimeState)
      .values({ agentId: seeded.authorAgentId, companyId: seeded.companyId, adapterType: "codex_local" });
    const pidRows = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
    holderPid = pidRows[0]!.pid;
    const mode = await new Promise<"commit" | "rollback">((resolve) => {
      gate.settle = resolve;
      assigned = true;
    });
    if (mode === "rollback") throw new Error("barrier rollback");
  });
  const ready = await pollUntil(10_000, async () => assigned);
  return { gate, settled, holderPid, ready };
}

/** [ordering-D 지원] 게이트로 해제를 통제하는 테스트 소유 행 잠금. acquire 콜백이 잠금 문장을
 * 실행하고, 게이트 해제 전까지 트랜잭션이 해당 행을 홀드한다(주차/큐 순서 관찰용). */
export async function openGatedRowLock(db: Db, acquire: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<unknown>) {
  const gate = { settle: () => {} };
  let holderPid = 0;
  let assigned = false;
  const settled = db.transaction(async (tx) => {
    await acquire(tx);
    const pidRows = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
    holderPid = pidRows[0]!.pid;
    await new Promise<void>((resolve) => {
      gate.settle = resolve;
      assigned = true;
    });
  });
  const ready = await pollUntil(10_000, async () => assigned);
  return { gate, settled, holderPid, ready };
}
