// @vitest-environment node
// [workflow-child r9 — finding 1] native-finalization transition fence (design §1, tests 1-3 + 6).
// The corrected final UPDATE binds identity + current-status + receipt + retained-target to the
// actual target C row, so a stale native proposal can never overwrite a committed terminal child.
// Test 1 ports the historical BUG_NATIVE_CANCEL probe (/tmp/wfw9-next/probes.test.ts:102-115) as
// its SAFE opposite with the documented barrier relocation: the old returning()-proxy paused the
// old UN-transactioned UPDATE before it was sent (no locks held). The r9 helper executes its
// UPDATE inside a locked transaction whose tx handle bypasses outer proxies, so pausing there
// would hold P/I/S/C and deadlock public cancel — the barrier now pauses BEFORE the helper's
// transaction opens instead. Sync-path transaction order for an empty receipted child:
//   #1 step materialization, #2 native-finalization helper, #3+ settlement hook.
import { eq } from "drizzle-orm";
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
import { applyLinkedWorkflowRunFinalization } from "../services/workflow/workflow-child-native-finalization.js";
import { resolveWorkflowRunFinalizationGate } from "../services/workflow/workflow-cancel-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Gate = Awaited<ReturnType<typeof resolveWorkflowRunFinalizationGate>>;
type LinkedGate = Extract<Gate, { kind: "linked" }>;
type Fixture = Awaited<ReturnType<typeof linkedChild>>;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** linked child + EMPTY definition(법정 네이티브 완성 대상) + 선택적 materialization 영수증. */
async function linkedChild(name: string, opts: { childStatus?: string; receipt?: boolean } = {}) {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({ companyId, name: `${name}-child`, steps: [] });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId,
    childWorkflowId: childDefId, childStatus: opts.childStatus ?? "running",
  });
  if (opts.receipt !== false) {
    await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, identity.childRunId));
  }
  return { ...identity, companyId, parentRunId: runId, stepRunId, childDefId, parentDefId };
}

const cRow = async (runId: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0];
const sRow = async (stepRunId: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
const fullSnap = async () => JSON.stringify({
  r: await db.select().from(workflowRuns),
  s: await db.select().from(workflowStepRuns),
  i: await db.select().from(workflowStepInvocations),
});
const gateOrThrow = async (x: Fixture, nextStatus: string): Promise<LinkedGate> => {
  const gate = await resolveWorkflowRunFinalizationGate(db, { runId: x.childRunId, companyId: x.companyId, nextStatus });
  if (gate.kind !== "linked") throw new Error(`expected linked gate, got ${gate.kind}`);
  return gate;
};
const finalizeWith = (gate: LinkedGate, x: Fixture, nextStatus: string) =>
  applyLinkedWorkflowRunFinalization(db, {
    bound: gate.bound, companyId: x.companyId, nextStatus,
    patch: { startedAt: new Date(), completedAt: new Date() }, boundWhere: gate.boundWhere,
  });
type ToolResult = { toolResult?: { success?: boolean; error?: string } };

/**
 * sync 경로 트랜잭션 바리어 프록시. interceptCall=2 는 native-finalization helper(#1 은 step
 * materialization, #3+ 는 정산 훅)를 겨냥한다. "pause-before" 는 실제 트랜잭션이 열리기 전에
 * 멈춘다 — helper 가 잠금을 전혀 보유하지 않은 시점이라 공개 취소가 완주할 수 있다(설계 §1 이
 * 요구하는 기계적 바리어 재배치 — 문서화됨). signal 로 발화 차례를 전달해 #2 임을 단언한다.
 */
function barrierProxy(interceptCall: number, signal: (callIndex: number) => void, hold: Promise<void>): Db {
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
        return (async () => {
          signal(calls); // helper tx 개시 직전 — 잠금 보유 전
          await hold;
          return realTransaction(cb);
        })();
      };
    },
  }) as unknown as Db;
}

describeEmbeddedPostgres("workflow child r9 — native finalization transition fence (finding 1)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r9-native-");
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

  it("stale patch, cancellation wins: sync paused before the helper tx, committed public cancel keeps C cancelled and S failed; sync reports cancelled (BUG safe opposite)", async () => {
    const x = await linkedChild("r9-stale");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let firedAtCall = 0;
    let resolveReached!: () => void;
    const reached = new Promise<void>((resolve) => { resolveReached = resolve; });
    const proxied = barrierProxy(2, (callIndex) => {
      firedAtCall = callIndex;
      resolveReached();
    }, hold);
    const syncPromise = syncWorkflowRunState(proxied, x.childRunId);
    syncPromise.catch(() => {});
    await Promise.race([reached, sleep(5_000).then(() => { throw new Error("helper tx barrier never reached"); })]);
    // 바리어는 #2(helper tx 개시 직전)에서 발화 — materialization(#1)은 이미 종료됐고 helper 는
    // 아직 잠금을 보유하지 않는다. 이 공백에 공개 취소가 완주한다(재배치된 바리어의 요구).
    expect(firedAtCall).toBe(2);
    expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(true);
    const cancelledC = await cRow(x.childRunId);
    const settledS = await sRow(x.stepRunId);
    expect(cancelledC?.status).toBe("cancelled");
    expect(settledS?.status).toBe("failed");
    expect((settledS?.metadata as ToolResult)?.toolResult?.error).toBe("child_run_cancelled");
    release();
    const result = await syncPromise;
    // 동기화 결과는 재적재된 내구 행이다 — 조합된 completed 날조가 아니다.
    expect(result.status).toBe("cancelled");
    expect(await cRow(x.childRunId)).toEqual(cancelledC);
    // 중복 S 전이 없음 — 취소가 남긴 정산 스냅숏(버전 포함)이 그대로다.
    expect(await sRow(x.stepRunId)).toEqual(settledS);
  }, 20_000);

  it("cancel before sync (original control): committed cancellation survives sync; repeating sync leaves timestamps/receipt/lease/toolResult/transition version unchanged", async () => {
    const x = await linkedChild("r9-before");
    expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(true);
    expect((await sRow(x.stepRunId))?.status).toBe("failed");
    const first = await syncWorkflowRunState(db, x.childRunId);
    expect(first.status).toBe("cancelled");
    expect((await cRow(x.childRunId))?.status).toBe("cancelled");
    const cBefore = await cRow(x.childRunId);
    const sBefore = await sRow(x.stepRunId);
    await syncWorkflowRunState(db, x.childRunId);
    expect(await cRow(x.childRunId)).toEqual(cBefore);
    expect(await sRow(x.stepRunId)).toEqual(sBefore);
  });

  it("native sync without cancel (original control): empty receipted child completes; a second sync keeps terminal C and S snapshots byte-identical", async () => {
    const x = await linkedChild("r9-native");
    const result = await syncWorkflowRunState(db, x.childRunId);
    expect(result.status).toBe("completed");
    expect((await cRow(x.childRunId))?.status).toBe("completed");
    const settled = await sRow(x.stepRunId);
    expect(settled?.status).toBe("completed");
    expect((settled?.metadata as ToolResult)?.toolResult?.success).toBe(true);
    const cBefore = await cRow(x.childRunId);
    const sBefore = await sRow(x.stepRunId);
    await syncWorkflowRunState(db, x.childRunId);
    expect(await cRow(x.childRunId)).toEqual(cBefore);
    expect(await sRow(x.stepRunId)).toEqual(sBefore);
  });

  it("saved gate after identity/eligibility mutation never writes the substituted identity — donor and recipient rows preserved", async () => {
    const co = await createCompanyFixture("r9-gates");
    const donor = await linkedChild("r9-gates-donor", { receipt: false });
    const foreignCompany = await createCompanyFixture("r9-gates-foreign");
    const altDefId = await insertDefinition({ companyId: co, name: "r9-gates-alt", steps: [] });
    const swaps: Array<[string, (x: Fixture) => Promise<unknown>]> = [
      ["C parent pointers", (x) => db.update(workflowRuns).set({ parentRunId: donor.parentRunId, parentStepRunId: donor.stepRunId }).where(eq(workflowRuns.id, x.childRunId))],
      ["C company", (x) => db.update(workflowRuns).set({ companyId: foreignCompany }).where(eq(workflowRuns.id, x.childRunId))],
      ["C workflow pointer", (x) => db.update(workflowRuns).set({ workflowId: altDefId }).where(eq(workflowRuns.id, x.childRunId))],
      ["S.retryCount", (x) => db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, x.stepRunId))],
      ["S.workflowRetry key", (x) => db.update(workflowStepRuns).set({ metadata: { workflowRetry: { attempt: 1 } } }).where(eq(workflowStepRuns.id, x.stepRunId))],
    ];
    for (const [label, mutate] of swaps) {
      const x = await linkedChild("r9-gates-a", { receipt: false });
      const savedGate = await gateOrThrow(x, "completed"); // 게이트는 변이 전에 저장된 스테일 게이트
      await mutate(x);
      const before = await fullSnap();
      expect((await finalizeWith(savedGate, x, "completed")).outcome, label).toBe("no-op");
      expect(await fullSnap(), label).toBe(before);
    }
  });

  it("terminal C refuses every proposal with zero writes; completed without receipt is refused and receipted empty completion wins", async () => {
    for (const childStatus of ["failed", "cancelled", "completed"]) {
      const x = await linkedChild(`r9-term-${childStatus}`, { childStatus, receipt: true });
      const before = await fullSnap();
      for (const nextStatus of ["running", "completed", "failed", "cancelled"]) {
        const gate = await gateOrThrow(x, nextStatus);
        expect((await finalizeWith(gate, x, nextStatus)).outcome, `${childStatus} → ${nextStatus}`).toBe("no-op");
      }
      expect(await fullSnap(), childStatus).toBe(before);
    }
    // 완료 제안은 materialization 영수증을 요구한다 — 없으면 제안 거부, 있으면(빈 정의) 승자.
    const x = await linkedChild("r9-receipt", { receipt: false });
    const gate = await gateOrThrow(x, "completed");
    expect((await finalizeWith(gate, x, "completed")).outcome).toBe("no-op");
    expect((await cRow(x.childRunId))?.status).toBe("running");
    await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
    const win = await finalizeWith(gate, x, "completed");
    expect(win.outcome).toBe("updated");
    if (win.outcome === "updated") {
      expect(win.run.status).toBe("completed");
      expect(win.run.childStartToken).toBeNull();
      expect(win.run.childStartLeaseExpiresAt).toBeNull();
    }
    expect((await cRow(x.childRunId))?.status).toBe("completed");
  });
});
