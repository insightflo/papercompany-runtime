// @vitest-environment node
// [workflow-child r9 — finding 1, races] native finalization vs public cancel concurrency
// (design §1 tests 4-5). PostgreSQL lock waits are observed by PID only — pg_stat_activity
// wait_event_type='Lock' with pg_blocking_pids containing the holder PID (r8 settlement-locks
// pattern). Application barriers are never lock-wait evidence. Test 4 lets the native helper
// hold P→I→S→C THROUGH its real final UPDATE (commit pending); test 5 exercises the exported
// boundWhere below the authoritative-lock wrapper against concurrently committed C mutations.
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";
import { workflowService } from "../services/workflow/engine.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { resolveWorkflowRunFinalizationGate } from "../services/workflow/workflow-cancel-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let sideDb: ReturnType<typeof createDb>; // 별도 실제 핸들 — cancelRun / predicated target UPDATE
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Gate = Awaited<ReturnType<typeof resolveWorkflowRunFinalizationGate>>;
type LinkedGate = Extract<Gate, { kind: "linked" }>;
type Fixture = Awaited<ReturnType<typeof linkedChild>>;
type RunRow = typeof workflowRuns.$inferSelect;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** linked child + EMPTY definition + materialization 영수증(r9 네이티브 완성 레이스 표적). */
async function linkedChild(name: string) {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({ companyId, name: `${name}-child`, steps: [] });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus: "running",
  });
  await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, identity.childRunId));
  return { ...identity, companyId, parentRunId: runId, stepRunId, childDefId, parentDefId };
}

const cRow = async (runId: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0];
const sRow = async (stepRunId: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
const gateOrThrow = async (x: Fixture, nextStatus: string): Promise<LinkedGate> => {
  const gate = await resolveWorkflowRunFinalizationGate(db, { runId: x.childRunId, companyId: x.companyId, nextStatus });
  if (gate.kind !== "linked") throw new Error(`expected linked gate, got ${gate.kind}`);
  return gate;
};
type ToolResult = { toolResult?: { success?: boolean; error?: string } };

/** helper tx 가 실제 최종 UPDATE 를 실행해 잠금을 보유한 채 커밋 보류 상태에 들어가게 하는 프록시.
 *  #2(helper) 콜백을 끝까지 실행한 뒤 커밋 전에 insideTx(=holder PID 캡처) → 시그널 → 대기. */
function holdInsideProxy(
  interceptCall: number,
  insideTx: (tx: Db) => Promise<void>,
  signal: () => void,
  hold: Promise<void>,
): Db {
  let calls = 0;
  const realTransaction = db.transaction.bind(db) as (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  return new Proxy(db as unknown as Record<string | symbol, unknown>, {
    get(t, key) {
      if (key !== "transaction") {
        const value = t[key];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(db) : value;
      }
      return (cb: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        if (calls !== interceptCall) return realTransaction(cb);
        return realTransaction(async (tx) => {
          const result = await cb(tx);
          await insideTx(tx as Db);
          signal();
          await hold;
          return result;
        });
      };
    },
  }) as unknown as Db;
}

/** 실제 잠금 대기 관찰 — PID 기준만 인정(쿼리 부분문자열/타임아웃 불인정, r8 설계). */
async function observeLockWait(pending: Promise<unknown>, holderPid: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = (await db.execute(sql`
      select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
    `)) as unknown as Array<{ pid: number; blockers: number[] }>;
    const waiter = rows.find((row) => row.blockers.includes(holderPid));
    if (waiter) return waiter.pid;
    const finished = await Promise.race([pending.then(() => true, () => false), sleep(0).then(() => false)]);
    if (finished) break;
    await sleep(5);
  }
  throw new Error("no backend was observed waiting (Lock) on the held transaction");
}

/** reserve 세션 holder — 지정 UPDATE 의 행 잠금을 트랜잭션으로 보유한다. 설정 실패는 전파. */
async function holdRow(statement: string, params: unknown[]) {
  const client = await db.$client.reserve();
  const q = (text: string, p: unknown[] = []) => client.unsafe(text, p);
  try {
    await q("begin");
    await q(statement, params);
  } catch (error) {
    await q("rollback").catch(() => {});
    client.release();
    throw error;
  }
  const { pid } = (await q("select pg_backend_pid() as pid"))[0] as { pid: number };
  return {
    pid,
    commit: async () => { await q("commit"); client.release(); },
    rollback: async () => { await q("rollback"); client.release(); },
  };
}

/** helper SET 형태 그대로의 실제 대상 UPDATE — boundWhere 는 bridge 가 생성한 진짜 술어. */
const execTargetUpdate = (gate: LinkedGate) =>
  sideDb.update(workflowRuns).set({
    status: "completed",
    startedAt: sql`coalesce(${workflowRuns.startedAt}, ${new Date().toISOString()}::timestamptz)`,
    completedAt: new Date(),
    childStartToken: null,
    childStartLeaseExpiresAt: null,
  }).where(gate.boundWhere).returning() as unknown as Promise<RunRow[]>;

describeEmbeddedPostgres("workflow child r9 — native finalization races (finding 1)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r9-native-races-");
    db = createDb(tempDb.connectionString);
    sideDb = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [toolDefinitions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await sideDb.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("native wins, cancel waits: helper holds P→I→S→C through its final UPDATE; cancel's backend observed blocked by PID; cancel false and S settles exactly once", async () => {
    const x = await linkedChild("r9-race");
    const sBefore = await sRow(x.stepRunId);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let holderPid = 0;
    let resolveHeld!: () => void;
    const held = new Promise<void>((resolve) => { resolveHeld = resolve; });
    const proxied = holdInsideProxy(2, async (tx) => {
      const rows = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
      holderPid = rows[0]!.pid;
    }, resolveHeld, hold);
    const syncPromise = syncWorkflowRunState(proxied, x.childRunId);
    syncPromise.catch(() => {});
    await Promise.race([held, sleep(5_000).then(() => { throw new Error("helper tx hold never reached"); })]);
    expect(holderPid).toBeGreaterThan(0);
    const cancelPromise = workflowService.cancelRun(sideDb, { runId: x.childRunId, companyId: x.companyId });
    cancelPromise.catch(() => {});
    const waiterPid = await observeLockWait(cancelPromise, holderPid);
    expect(waiterPid).not.toBe(holderPid);
    release(); // helper tx 커밋 — writer 의 500ms lock_timeout 안에 해제
    expect(await cancelPromise).toBe(false);
    expect((await syncPromise).status).toBe("completed");
    expect((await cRow(x.childRunId))?.status).toBe("completed");
    // 물리 종말 전이 정확히 1회 — S 상태 + 전이 버전 +1(해결된 프라미스가 아닌 실제 레코드).
    const settled = await sRow(x.stepRunId);
    expect(settled?.status).toBe("completed");
    expect(settled?.statusTransitionVersion).toBe((sBefore?.statusTransitionVersion ?? 0) + 1);
    expect((settled?.metadata as ToolResult)?.toolResult?.success).toBe(true);
  }, 20_000);

  it("final target predicate defense: held cancellation commit re-evaluated by the real predicated target UPDATE — zero RETURNING, C stays cancelled", async () => {
    const x = await linkedChild("r9-pred");
    const gate = await gateOrThrow(x, "completed");
    const holder = await holdRow("update workflow_runs set status = 'cancelled' where id = $1", [x.childRunId]);
    let pending: Promise<RunRow[]> | undefined;
    try {
      pending = execTargetUpdate(gate);
      pending.catch(() => {});
      const waiterPid = await observeLockWait(pending, holder.pid);
      expect(waiterPid).not.toBe(holder.pid);
      await holder.commit(); // 취소를 먼저 커밋 — 대기 중 UPDATE 는 최신 상태로 재평가한다
    } catch (error) {
      await holder.rollback();
      await pending?.catch(() => {});
      throw error;
    }
    expect(await pending!).toEqual([]);
    expect((await cRow(x.childRunId))?.status).toBe("cancelled");
  }, 20_000);

  it("retained-target equality is on the target itself: stale gate + drifted C.workflow_id re-evaluated under a held row lock — zero rows, drift retained", async () => {
    const x = await linkedChild("r9-drift");
    const altDefId = await insertDefinition({ companyId: x.companyId, name: "r9-drift-alt", steps: [] });
    const gate = await gateOrThrow(x, "completed"); // 드리프트 전에 저장된 스테일 게이트
    const holder = await holdRow("update workflow_runs set workflow_id = $1 where id = $2", [altDefId, x.childRunId]);
    let pending: Promise<RunRow[]> | undefined;
    try {
      pending = execTargetUpdate(gate);
      pending.catch(() => {});
      const waiterPid = await observeLockWait(pending, holder.pid);
      expect(waiterPid).not.toBe(holder.pid);
      await holder.commit();
    } catch (error) {
      await holder.rollback();
      await pending?.catch(() => {});
      throw error;
    }
    expect(await pending!).toEqual([]);
    const drifted = await cRow(x.childRunId);
    expect(drifted?.workflowId).toBe(altDefId); // 드리프트가 승리 — 구 C 별칭이 아닌 대상 자신 등식
    expect(drifted?.status).toBe("running");
  }, 20_000);
});
