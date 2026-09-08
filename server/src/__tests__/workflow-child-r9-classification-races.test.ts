// @vitest-environment node
// [workflow-child r9 §2 races] stale-wins / classifier-wins orderings with REAL PostgreSQL
// lock-wait observation: pg_stat_activity wait_event_type='Lock' + pg_blocking_pids — no query
// substring guessing, application barriers are not lock evidence. Stale-wins: T1 commits the
// stale mutation while the writer waits on the held row; the writer must re-read eligibility
// under locks and return exact no-op BEFORE classification/activity. Classifier-wins: the
// writer holds P→I→S→C through classification (pre-commit barrier), T1's stale drift really
// waits, then invalid-state + its activity land, and T1's committed mutation is verified.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";
import {
  failLinkedChildStep, settleLinkedChildStepFromTerminal, type FailChildStepOutcome,
} from "../services/workflow/workflow-child-settlement-writers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; parentRunId: string; parentStepRunId: string; stepId: string; invocationId: string;
  childRunId: string; generation: 1; childDefId: string; parentDefId: string; runId: string; stepRunId: string;
};
type Writer = (x: Fixture) => Promise<FailChildStepOutcome>;
const settle: Writer = (x) => settleLinkedChildStepFromTerminal(db, x);
const fail: Writer = (x) => failLinkedChildStep(db, x, { errorCode: "r9_race", detail: "r9 race probe" });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 자격 있는 malformed 베이스(completed-no-receipt C, S pending, P running) — T1 없으면 invalid-state. */
async function raceFixture(name: string): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({ companyId, name: `${name}-child`, steps: [] });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus: "completed",
  });
  return { ...identity, companyId, runId, stepRunId, childDefId, parentDefId };
}

/** 별도 세션 holder(T1) — begin + stale UPDATE. classifier-wins 순서에선 writer의 잠금에 막힌다. */
async function heldUpdate(sqlText: string, params: unknown[]) {
  const client = await db.$client.reserve();
  const q = (text: string, p: unknown[] = []) => client.unsafe(text, p as never[]);
  try {
    await q("begin");
    await q("select set_config('lock_timeout','5s',true), set_config('statement_timeout','5s',true)");
    const { pid } = (await q("select pg_backend_pid() as pid"))[0] as unknown as { pid: number };
    const applied = q(sqlText, params);
    // postgres.js 큐 플러시 편차 방어 — UPDATE가 서버에 도착해(잠금 대기 Lock 또는 완료) 관측
    // 가능 상태가 될 때까지 bounded 대기한다. 도착 전에 관측을 시작하면 유령 실패/교착이 된다.
    for (let n = 0; n < 200; n++) {
      const settled = await Promise.race([applied.then(() => true, () => true), sleep(0).then(() => false)]);
      if (settled) break;
      const probe = (await db.execute(sql`select wait_event_type from pg_stat_activity
        where pid = ${pid}::int and state = 'active'`)) as unknown as Array<{ wait_event_type: string }>;
      if (probe.length > 0 && probe[0]!.wait_event_type === "Lock") break;
      await sleep(5);
    }
    return {
      pid, applied,
      commit: async () => {
        try { await applied; await q("commit"); } finally { client.release(); }
      },
      rollback: async () => {
        try { await applied; await q("rollback"); } catch { /* 이미 중단/해제됨 */ }
        try { client.release(); } catch { /* 이중 release */ }
      },
    };
  } catch (error) {
    await q("rollback").catch(() => {});
    client.release();
    throw error;
  }
}

/** writer backend가 holder의 행 잠금에서 대기 중임을 PID로 관측(waiter blockers ⊇ holder.pid). */
async function observeWriterWaitingOn(pending: Promise<unknown>, holderPid: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = (await db.execute(sql`
      select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
    `)) as unknown as Array<{ pid: number; blockers: number[] }>;
    const writer = rows.find((row) => row.blockers.includes(holderPid));
    if (writer) return writer.pid;
    const finished = await Promise.race([pending.then(() => true, () => false), sleep(0).then(() => false)]);
    if (finished) break;
    await sleep(5);
  }
  throw new Error("writer backend was never observed waiting (Lock) on the held stale row");
}

/** classifier-wins: T1이 writer의 잠금에 막혀 실제 대기 중임을 관측(blockers 비어있지 않음). */
async function observeHolderWaiting(holderPid: number): Promise<number[]> {
  for (let n = 0; n < 400; n++) {
    const rows = (await db.execute(sql`
      select pg_blocking_pids(${holderPid}::int) as blockers from pg_stat_activity
      where pid = ${holderPid}::int and wait_event_type = 'Lock'
    `)) as unknown as Array<{ blockers: number[] }>;
    if (rows.length > 0 && rows[0]!.blockers.length > 0) return rows[0]!.blockers;
    await sleep(5);
  }
  throw new Error("T1 stale mutation was never observed really waiting on the writer's held row lock");
}

const refusalCount = async (companyId: string): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(activityLog)
    .where(and(eq(activityLog.action, "workflow_child.completion_refused_invalid_state"), eq(activityLog.companyId, companyId)));
  return row?.n ?? 0;
};
const stepRowOf = async (x: Fixture) =>
  (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0]!;
const childRowOf = async (x: Fixture) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId)))[0]!;

const holdRetryMeta = (x: Fixture) => ({
  text: `update workflow_step_runs set metadata='{"workflowRetry":null}'::jsonb where id=$1`, params: [x.stepRunId],
});
const verifyRetryMeta = async (x: Fixture) => {
  const row = await stepRowOf(x);
  expect(row.status).toBe("pending");
  expect((row.metadata as Record<string, unknown>).workflowRetry).toBeNull();
};
const holdDrift = (x: Fixture, alt: string) => ({ text: "update workflow_runs set workflow_id=$1 where id=$2", params: [alt, x.childRunId] });
const verifyDrift = async (x: Fixture, alt: string) => {
  expect((await childRowOf(x)).workflowId).toBe(alt);
  expect((await stepRowOf(x)).status).toBe("pending");
};

describeEmbeddedPostgres("workflow child r9 races — stale-wins vs classifier-wins settlement", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r9-classification-races-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const staleCases: Array<{
    label: string; writer: Writer;
    hold: (x: Fixture, alt: string) => { text: string; params: unknown[] };
    verify: (x: Fixture, alt: string) => Promise<void>;
  }> = [
    { label: "settle × S retry-metadata", writer: settle, hold: holdRetryMeta, verify: verifyRetryMeta },
    { label: "fail × S retry-metadata", writer: fail, hold: holdRetryMeta, verify: verifyRetryMeta },
    { label: "settle × C retained-target drift", writer: settle, hold: holdDrift, verify: verifyDrift },
    { label: "fail × C retained-target drift", writer: fail, hold: holdDrift, verify: verifyDrift },
    {
      label: "settle × P.status lock winner", writer: settle,
      hold: (x) => ({ text: "update workflow_runs set status='failed' where id=$1", params: [x.runId] }),
      verify: async (x) => {
        expect((await childRowOf(x)).status).toBe("completed");
        expect((await stepRowOf(x)).status).toBe("pending");
      },
    },
    {
      label: "fail × S.status lock winner", writer: fail,
      hold: (x) => ({ text: "update workflow_step_runs set status='failed' where id=$1", params: [x.stepRunId] }),
      verify: async (x) => { expect((await childRowOf(x)).status).toBe("completed"); },
    },
  ];

  for (const raceCase of staleCases) {
    it(`stale-wins ${raceCase.label}: T1 commits the stale mutation while the writer waits on the held row (PID-observed) → exact no-op, zero activity, T1 landed`, async () => {
      const x = await raceFixture("r9 stale");
      const alt = await insertDefinition({ companyId: x.companyId, name: "r9-alt-def", steps: [] });
      const { text, params } = raceCase.hold(x, alt);
      const holder = await heldUpdate(text, params);
      await holder.applied; // T1 변이는 잠금 보유(open tx) 상태로 즉시 성공해야 한다
      let pending: Promise<FailChildStepOutcome> | undefined;
      try {
        pending = raceCase.writer(x);
        const writerPid = await observeWriterWaitingOn(pending, holder.pid);
        expect(writerPid).not.toBe(holder.pid);
        await holder.commit(); // writer의 500ms lock_timeout 안에 커밋
      } catch (error) {
        await holder.rollback();
        await pending?.catch(() => {});
        throw error;
      }
      expect(await pending).toEqual({ outcome: "no-op" });
      expect(await refusalCount(x.companyId)).toBe(0);
      await raceCase.verify(x, alt);
    }, 15_000);
  }

  it("classifier-wins: writer classifies under held P→I→S→C locks (pre-commit barrier), T1 stale drift really waits, then invalid-state + activity land and T1 commits", async () => {
    const x = await raceFixture("r9 classifier");
    const alt = await insertDefinition({ companyId: x.companyId, name: "r9-cl-alt", steps: [] });
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const proxied = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
            (target.transaction as (c: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>)(
              async (tx) => {
                const result = await callback(tx); // 잠금 + 분류 완료(커밋 전)
                reached();
                await gate; // 커밋 보류 — P→I→S→C 잠금은 계속 보유
                return result;
              }, config);
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const pending = settleLinkedChildStepFromTerminal(proxied, x);
    await Promise.race([
      reachedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("writer never reached the post-classification barrier")), 5_000)),
    ]);
    const holder = await heldUpdate("update workflow_runs set workflow_id=$1 where id=$2", [alt, x.childRunId]);
    let blockers: number[];
    try {
      blockers = await observeHolderWaiting(holder.pid);
      expect(blockers).not.toContain(holder.pid); // 대기 자는 T1, 잡은 쪽은 writer의 열린 트랜잭션
    } catch (error) {
      release(); // 먼저 writer를 풀어야 T1의 applied가 풀리고 rollback이 끝난다(교착 방지)
      await holder.rollback();
      await pending.catch(() => {});
      throw error;
    }
    release();
    expect(await pending).toEqual({
      outcome: "invalid-state", code: "workflow_child_invalid_state", version: 1,
      reason: "completed_without_materialization_receipt",
    });
    expect(await refusalCount(x.companyId)).toBe(1); // post-unlock activity는 잠금 관측의 유효 기록
    await holder.commit(); // T1의 변이는 writer 해제 후 실제로 커밋된다
    expect((await childRowOf(x)).workflowId).toBe(alt); // T1 커밋 검증 — 전체 DB 불변 단언 금지
  }, 20_000);
});
