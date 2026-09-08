// @vitest-environment node
// [workflow-child r8 — finding 2] target-tuple settlement + authoritative locks (design §2).
// BUG#4 safe opposite: T1 commits a legal terminal S while the real writer waits on the S row
// FOR UPDATE — observed by the writer backend's PID in pg_stat_activity (wait_event_type='Lock',
// pg_blocking_pids = holder PID; no query substring). Writer must be no-op, S byte-unchanged.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
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
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertMaterializedChildRun,
  insertOrphanChildMarkedRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";
import {
  failLinkedChildStep,
  failTombstoneChildStep,
  settleLinkedChildStepFromTerminal,
  type FailChildStepOutcome,
} from "../services/workflow/workflow-child-settlement-writers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type LinkedFixture = Awaited<ReturnType<typeof matLinked>>; type TombstoneFixture = Awaited<ReturnType<typeof tombstoneFixture>>;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** linked 자식 + materialization 영수증 + 초기 스텝 행 픽스처 — identity 필드가 최상위에 있다. */
async function matLinked(name: string, companyId: string, childStatus = "completed") {
  const childDefId = await insertDefinition({
    companyId, name: `${name}-child`,
    steps: [{ id: "child-a", name: "A", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
  });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertMaterializedChildRun(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus,
  });
  return { ...identity, runId, stepRunId, childDefId };
}

/** tombstone(linked+NULL) 픽스처 — targetWorkflowId 필수(0101 NOT NULL). */
async function tombstoneFixture(name: string, companyId: string) {
  const childDefId = await insertDefinition({ companyId, name: `${name}-ghost`, steps: [] });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const { invocationId } = await insertTombstoneInvocation(db, {
    companyId, parentStepRunId: stepRunId, targetWorkflowId: childDefId,
  });
  return { companyId, parentRunId: runId, stepRunId, parentStepRunId: stepRunId, stepId: "run-child", invocationId, generation: 1 as const, childDefId };
}

const stepSnap = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0];
const fullSnap = async () => JSON.stringify({
  s: await db.select().from(workflowStepRuns), i: await db.select().from(workflowStepInvocations), r: await db.select().from(workflowRuns),
});

// 별도 pg 클라이언트(reserve session) holder — T1: 법정 종말 S 로 갱신 + FOR UPDATE 보유.
// setup 오류는 rollback+release 후 그대로 전파된다.
async function holdStepRow(stepRunId: string, terminalStatus: string) {
  const client = await db.$client.reserve();
  const q = (text: string, params: unknown[] = []) => client.unsafe(text, params);
  try {
    await q("begin");
    await q("select set_config('lock_timeout','5s',true), set_config('statement_timeout','5s',true)");
    await q("update workflow_step_runs set status = $1 where id = $2", [terminalStatus, stepRunId]);
    await q("select id from workflow_step_runs where id = $1 for update", [stepRunId]);
  } catch (error) {
    await q("rollback").catch(() => {});
    await client.release();
    throw error;
  }
  const { pid } = (await q("select pg_backend_pid() as pid"))[0] as { pid: number };
  return {
    pid,
    commit: async () => { await q("commit"); await client.release(); },
    rollback: async () => { await q("rollback"); await client.release(); },
  };
}

/**
 * 실제 잠금 대기 관찰 — writer 의 backend 를 PID 로 확인(wait_event_type='Lock', blockers 에
 * holder PID). 쿼리 텍스트 부분문자열은 쓰지 않는다(r8 설계). 대기 없이 끝나면 즉시 실패.
 */
async function observeLockWait(pending: Promise<unknown>, holderPid: number): Promise<number> {
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
  throw new Error("writer backend was never observed waiting (Lock) on the held S row lock");
}

describeEmbeddedPostgres("workflow child r8 — settlement locks (finding 2)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-settle-locks-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [toolDefinitions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  // 실제 잠금 대기 — 4 writer 형 모두. T1 이 법정 종말 S 를 커밋하면 T2 는 no-op 이고 S 는 바이트 불변이다.
  const lockCases: Array<{ label: string; holdStatus: string; make: (co: string) => Promise<{ stepRunId: string }>; writer: (x: never) => Promise<FailChildStepOutcome> }> = [
    { label: "linked success", holdStatus: "failed", make: (co) => matLinked("lw-success", co), writer: (x) => settleLinkedChildStepFromTerminal(db, x) },
    { label: "explicit linked failure", holdStatus: "completed", make: (co) => matLinked("lw-explicit", co, "failed"), writer: (x) => failLinkedChildStep(db, x, { errorCode: "probe_fail", detail: "held lock race" }) },
    { label: "terminal-derived linked failure", holdStatus: "skipped", make: (co) => matLinked("lw-terminal", co, "failed"), writer: (x) => settleLinkedChildStepFromTerminal(db, x) },
    { label: "tombstone", holdStatus: "completed", make: (co) => tombstoneFixture("lw-tomb", co), writer: (x) => failTombstoneChildStep(db, x) },
  ];
  for (const lockCase of lockCases) {
    it(`${lockCase.label}: real S FOR UPDATE wait observed by PID, then committed terminal S → no-op, S byte-unchanged`, async () => {
      const x = await lockCase.make(await createCompanyFixture(lockCase.label));
      const before = await stepSnap(x.stepRunId);
      const holder = await holdStepRow(x.stepRunId, lockCase.holdStatus);
      let pending: Promise<FailChildStepOutcome> | undefined;
      try {
        pending = lockCase.writer(x as never);
        const writerPid = await observeLockWait(pending, holder.pid);
        expect(writerPid).not.toBe(holder.pid);
        await holder.commit(); // writer 의 500ms lock_timeout 안에 커밋
      } catch (error) {
        await holder.rollback();
        await pending?.catch(() => {});
        throw error;
      }
      expect(await pending!).toEqual({ outcome: "no-op" });
      expect(await stepSnap(x.stepRunId)).toEqual({
        ...before,
        status: lockCase.holdStatus,
        statusTransitionVersion: before.statusTransitionVersion + 1, // T1 자신의 상태 변경분만
      });
    });
  }

  // 2) 사전 잠금 게이트 — T2 가 잠금 전에 본 최신 커밋 상태가 권위다. cancelled 부모는 정산
  //    (positive control), failed 부모/S 신원 편집/I·C 연결 변경은 전부 no-op + 행 보존.
  it("pre-lock gates: cancelled parent settles (control); failed parent and identity/association edits are no-op with rows preserved", async () => {
    const co = await createCompanyFixture("gates");
    const control = await matLinked("gate-cancel", co);
    await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, control.runId));
    expect((await settleLinkedChildStepFromTerminal(db, control)).outcome).toBe("settled");
    expect((await stepSnap(control.stepRunId)).status).toBe("completed");

    const donor = await matLinked("gate-donor", co);
    const foreignCo = await createCompanyFixture("gate-foreign");
    const sideStepRunId = await insertStepRunForRun({ runId: donor.parentRunId, stepId: "gate-side" });
    const orphanChildId = await insertOrphanChildMarkedRun(db, {
      companyId: co, parentRunId: donor.parentRunId, parentStepRunId: donor.stepRunId, childWorkflowId: donor.childDefId,
    });
    const gates: Array<[string, (x: LinkedFixture) => Promise<unknown>]> = [
      ["parent running→failed", async (x) => { await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, x.runId)); }],
      // 빈 run 으로 이동 — donor 의 (run, step) 좌표는 unique(workflow_run_id, step_id) 점유 중.
      ["S.workflow_run_id edit", async (x) => {
        const [donorParent] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, donor.parentRunId));
        const [fresh] = await db.insert(workflowRuns).values({ id: randomUUID(), workflowId: donorParent.workflowId, companyId: co, status: "running", triggeredBy: "board" }).returning({ id: workflowRuns.id });
        await db.update(workflowStepRuns).set({ workflowRunId: fresh.id }).where(eq(workflowStepRuns.id, x.stepRunId));
      }],
      ["S.step_id edit", async (x) => { await db.update(workflowStepRuns).set({ stepId: "other" }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
      ["S.retry_count edit", async (x) => { await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
      ["S.workflowRetry metadata", async (x) => { await db.update(workflowStepRuns).set({ metadata: { workflowRetry: { attempt: 1 } } }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
      ["I parent association swap", async (x) => { await db.update(workflowStepInvocations).set({ parentStepRunId: sideStepRunId }).where(eq(workflowStepInvocations.id, x.invocationId)); }],
      ["I child association swap", async (x) => { await db.update(workflowStepInvocations).set({ childRunId: orphanChildId }).where(eq(workflowStepInvocations.id, x.invocationId)); }],
      ["C parent change", async (x) => { await db.update(workflowRuns).set({ parentRunId: donor.parentRunId, parentStepRunId: donor.stepRunId }).where(eq(workflowRuns.id, x.childRunId)); }],
      ["C company change", async (x) => { await db.update(workflowRuns).set({ companyId: foreignCo }).where(eq(workflowRuns.id, x.childRunId)); }],
    ];
    for (const [label, mutate] of gates) {
      const x = await matLinked("gate", co);
      await mutate(x);
      const snapshot = await fullSnap();
      expect((await settleLinkedChildStepFromTerminal(db, x)).outcome, label).toBe("no-op");
      expect(await fullSnap(), label).toBe(snapshot);
    }
  });

  // 3) 500ms lock_timeout 초과 보유 → busy + 행 불변, 해제 후 새 시도는 정산한다.
  it("hold past the writer's 500ms lock_timeout → busy with rows unchanged; release, then a fresh retry settles", async () => {
    const x = await matLinked("busy", await createCompanyFixture("busy"));
    const before = await stepSnap(x.stepRunId);
    const holder = await holdStepRow(x.stepRunId, "failed");
    try {
      const pending = settleLinkedChildStepFromTerminal(db, x);
      await observeLockWait(pending, holder.pid);
      await sleep(600); // writer 의 lock_timeout(500ms) 을 넘게 보유
      expect(await pending).toEqual({ outcome: "busy" });
    } finally {
      await holder.rollback();
    }
    expect(await stepSnap(x.stepRunId)).toEqual(before);
    expect((await settleLinkedChildStepFromTerminal(db, x)).outcome).toBe("settled");
    const settled = await stepSnap(x.stepRunId);
    expect(settled.status).toBe("completed");
    expect((settled.metadata as Record<string, { success: boolean }>).toolResult.success).toBe(true);
  });

  // 4) 7축 순차 치환 — 같은 회사의 정합 donor 쌍으로 축별로 하나씩 훼짓 → 전부 no-op,
  //    donor/recipient 스냅숏 보존. 진짜 신원은 마지막에 정산된다.
  it("seven-axis sequential swaps against same-company coherent donors are no-ops preserving both snapshots; true identity settles", async () => {
    const co = await createCompanyFixture("axes");
    const a = await matLinked("axes-a", co);
    const b = await matLinked("axes-b", co);
    const foreign = await matLinked("axes-foreign", await createCompanyFixture("axes-foreign"));
    const swaps: Array<[string, unknown]> = [
      ["companyId", foreign.companyId],
      ["parentRunId", b.parentRunId],
      ["parentStepRunId", b.stepRunId],
      ["stepId", "other"],
      ["invocationId", b.invocationId],
      ["childRunId", b.childRunId],
      ["generation", 2],
    ];
    const before = await fullSnap();
    for (const [key, value] of swaps) {
      const forged = { ...a, [key]: value };
      expect((await settleLinkedChildStepFromTerminal(db, forged as LinkedFixture)).outcome, key).toBe("no-op");
      expect(await fullSnap(), key).toBe(before);
    }
    expect((await settleLinkedChildStepFromTerminal(db, a)).outcome).toBe("settled");
    expect((await stepSnap(b.stepRunId)).status).toBe("pending");
  });

  // 4b) tombstone 축 — childRunId 축은 무 applicable 대신 NULL→linked 변화를 검증한다.
  it("tombstone: applicable axes no-op with rows preserved; NULL→linked change keeps tombstone settlement a no-op", async () => {
    const co = await createCompanyFixture("tomb-axes");
    const t = await tombstoneFixture("tomb-axes", co);
    const donor = await matLinked("tomb-donor", co);
    const foreignCo = await createCompanyFixture("tomb-foreign");
    const swaps: Array<[string, unknown]> = [
      ["companyId", foreignCo],
      ["parentRunId", donor.parentRunId],
      ["parentStepRunId", donor.stepRunId],
      ["stepId", "other"],
      ["invocationId", donor.invocationId],
      ["generation", 2],
    ];
    const before = await fullSnap();
    for (const [key, value] of swaps) {
      const forged = { ...t, [key]: value };
      expect((await failTombstoneChildStep(db, forged as TombstoneFixture)).outcome, key).toBe("no-op");
      expect(await fullSnap(), key).toBe(before);
    }
    // NULL→linked — invocation 이 자식을 얻으면 tombstone 정산 대상에서 벗어난다.
    const orphanChildId = await insertOrphanChildMarkedRun(db, {
      companyId: co, parentRunId: t.parentRunId, parentStepRunId: t.parentStepRunId, childWorkflowId: t.childDefId,
    });
    await db.update(workflowStepInvocations).set({ childRunId: orphanChildId }).where(eq(workflowStepInvocations.id, t.invocationId));
    const afterLink = await fullSnap();
    expect((await failTombstoneChildStep(db, t)).outcome).toBe("no-op");
    expect(await fullSnap()).toBe(afterLink);
  });

  // 5) T2 잠금 전에 커밋된 무관한 metadata 키 — writer 는 실제 s.metadata 를 병합한다(보존).
  it("benign metadata committed before settlement is retained — the writer merges actual s.metadata", async () => {
    const x = await matLinked("benign", await createCompanyFixture("benign"));
    await db.update(workflowStepRuns).set({ metadata: { benign: { note: "unrelated" } } }).where(eq(workflowStepRuns.id, x.stepRunId));
    expect((await settleLinkedChildStepFromTerminal(db, x)).outcome).toBe("settled");
    const metadata = (await stepSnap(x.stepRunId)).metadata as Record<string, unknown>;
    expect(metadata.benign).toEqual({ note: "unrelated" });
    expect((metadata.toolResult as { success: boolean }).success).toBe(true);
  });
});
