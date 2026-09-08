// @vitest-environment node
// [workflow-child r8 finding 3 — 직접 자식 취소 vs DEAD 전파 정산] BUG#5 안전 반대(설계 r8 §3):
//   살아있는 부모 아래 linked 자식의 공개 취소(workflowService.cancelRun)는 직접 취소 writer
//   (claimDirectlyCancelledLinkedChildRun)로 성공하고, writer 는 C 만 바꾸는 부모-보존 경계라서
//   취소 결과는 기존 completion hook 으로 pending S 에 정산된다(child_run_cancelled). DEAD 전용
//   헬퍼(claimCancelledChildRunWithParentFence)는 살아있는 부모를 계속 거부하며, 종말 C 는 false,
//   신원/소유 경합과 지연 materialization 은 무쓰기 거부다. 테스트 더블 없음 — DB 상태만 단언한다.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";
import { claimDirectlyCancelledLinkedChildRun } from "../services/workflow/workflow-child-direct-cancel.js";
import {
  claimCancelledChildRunWithParentFence,
  findChildStartIdentityForRun,
  type ChildStartIdentity,
} from "../services/workflow/workflow-child-start-state.js";
import { executeWorkflowRunWithStartOutcome } from "../services/workflow/workflow-run-execution.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertChildStartLease, insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; parentRunId: string; stepRunId: string;
  childRunId: string; invocationId: string; childDefId: string; stepId: string;
  token?: string;
};

/** 살아있는 부모(running) + pending 부모 스텝 + linked 자식. downstream: P 활동 유지용 미실행 후속 스텝. */
async function linkedLive(
  name: string,
  opts: { downstream?: boolean; childStatus?: string; lease?: boolean; retryCount?: number; retryMeta?: boolean } = {},
): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: `${name}-child`,
    steps: [{ id: "child-a", name: "CA", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentSteps: unknown[] = [childStep(childDefId)];
  if (opts.downstream) {
    parentSteps.push({ id: "later", name: "Later", type: "agent", agentId: "", dependencies: ["run-child"] });
  }
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: parentSteps });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
    companyId, workflowId: parentDefId,
    retryCount: opts.retryCount,
    metadata: opts.retryMeta ? { workflowRetry: { attempt: 1 } } : undefined,
  });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId,
    childWorkflowId: childDefId, childStatus: opts.childStatus ?? "running",
  });
  const token = opts.lease
    ? await insertChildStartLease(db, { childRunId: identity.childRunId, mode: "active" })
    : undefined;
  return {
    companyId, parentRunId: runId, stepRunId, childRunId: identity.childRunId,
    invocationId: identity.invocationId, childDefId, stepId: identity.stepId, token,
  };
}

const runRow = async (runId: string) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
const identityOf = async (x: Fixture): Promise<ChildStartIdentity> =>
  (await findChildStartIdentityForRun(db, x.childRunId))!.identity;
const fenceOf = (id: ChildStartIdentity) => ({
  invocationId: id.invocationId, generation: id.generation,
  parentRunId: id.parentRunId, parentStepRunId: id.parentStepRunId,
});
const fencedCancel = (x: Fixture, fence: { invocationId: string; generation: number; parentRunId: string; parentStepRunId: string }) =>
  claimCancelledChildRunWithParentFence(db, { childRunId: x.childRunId, companyId: x.companyId, fence });
const directCancel = (x: Fixture) => claimDirectlyCancelledLinkedChildRun(db, {
  companyId: x.companyId, parentRunId: x.parentRunId, parentStepRunId: x.stepRunId,
  stepId: x.stepId, invocationId: x.invocationId, generation: 1, childRunId: x.childRunId,
});

/** writer 의 FOR UPDATE 잠금 대기 관측(backend wait_event_type 기준 — 쿼리 텍스트 추측 없음). */
async function observedLockWait(): Promise<boolean> {
  for (let n = 0; n < 200; n++) {
    const rows = await db.execute(sql`select 1 from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike '%for update%' and query ilike '%workflow_runs%'`);
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describeEmbeddedPostgres("workflow child r8 — direct child cancellation vs DEAD-only propagated cleanup", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-direct-cancel-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("BUG#5 opposite: public cancelRun on a live-parent linked child returns true — C cancelled with token/lease cleared, startedAt/receipt/deadline preserved, P still running at the public-return boundary", async () => {
    const x = await linkedLive("R8 DirectLive", { downstream: true, lease: true });
    await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
    const before = await runRow(x.childRunId);
    expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(true);
    const after = await runRow(x.childRunId);
    expect(after.status).toBe("cancelled");
    expect(after.childStartToken).toBeNull();
    expect(after.childStartLeaseExpiresAt).toBeNull();
    expect(after.startedAt?.getTime()).toBe(before.startedAt!.getTime());
    expect(after.childStartMaterializedAt?.getTime()).toBe(before.childStartMaterializedAt!.getTime());
    expect(after.childStartDeadlineAt?.getTime()).toBe(before.childStartDeadlineAt!.getTime());
    expect(after.completedAt).not.toBeNull();
    // [P 보존 경계] public 반환 시점에 부모는 여전히 running — 후속 스텝이 활동 작업으로 남는다.
    expect((await runRow(x.parentRunId)).status).toBe("running");
    const [later] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, x.parentRunId), eq(workflowStepRuns.stepId, "later"),
    ));
    expect(later?.status).toBe("pending");
  }, 20_000);

  it("cancelled-child result still reaches pending S through the normal completion hook — child_run_cancelled toolResult; parent-preservation does not suppress the hook; C never reopened", async () => {
    const x = await linkedLive("R8 DirectHook");
    expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(true);
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(s.status).toBe("failed");
    expect(s.completedAt).not.toBeNull();
    expect((s.metadata as Record<string, unknown>).toolResult).toEqual(expect.objectContaining({
      toolName: "workflow", success: false, error: "child_run_cancelled",
    }));
    expect((await runRow(x.childRunId)).status).toBe("cancelled");
  }, 20_000);

  it("SAFE control ported: DEAD-only fence cancel rejects foreign company and wrong parent, cancels a dead parent's child, and still refuses a live parent's linked child", async () => {
    const a = await linkedLive("R8 DeadA", { childStatus: "pending" });
    const b = await linkedLive("R8 DeadB", { childStatus: "pending" });
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, a.parentRunId));
    const before = await runRow(a.childRunId);
    const deadAid = await identityOf(a);
    expect(await claimCancelledChildRunWithParentFence(db, {
      childRunId: a.childRunId, companyId: b.companyId, fence: fenceOf(deadAid),
    })).toEqual([]);
    expect(await fencedCancel(a, { ...fenceOf(deadAid), parentRunId: b.parentRunId })).toEqual([]);
    expect(await runRow(a.childRunId)).toEqual(before);
    expect(await fencedCancel(a, fenceOf(deadAid))).toHaveLength(1);
    const live = await linkedLive("R8 DeadC", { childStatus: "pending" });
    const liveBefore = await runRow(live.childRunId);
    expect(await fencedCancel(live, fenceOf(await identityOf(live)))).toEqual([]);
    expect(await runRow(live.childRunId)).toEqual(liveBefore);
  });

  it("all insertable terminal C statuses refuse direct cancellation — cancelRun false, snapshots unchanged; aborted/timed-out are schema-rejected fixtures", async () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const x = await linkedLive(`R8 Term ${status}`, { childStatus: status });
      if (status === "completed") {
        await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
      }
      const before = await runRow(x.childRunId);
      expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(false);
      expect(await runRow(x.childRunId)).toEqual(before);
      expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0]?.status).toBe("pending");
    }
    // [스키마] aborted/timed-out 은 workflow_runs_status_check 로 삽입 자체가 거부된다 —
    // writer 의 status IN ('pending','running') 술어가 논리적으로 덮는다(분류 단위 검증은 receipt 스위트).
    for (const status of ["aborted", "timed-out"]) {
      await expect(linkedLive(`R8 Term ${status}`, { childStatus: status }))
        .rejects.toThrow(/workflow_runs_status_check/);
    }
  });

  it("identity/owner races refuse without writes: foreign company via public path, swapped P/S/I/C/step, generation!=1, retry_count>0, workflowRetry metadata", async () => {
    const a = await linkedLive("R8 RaceA");
    const b = await linkedLive("R8 RaceB");
    const before = await runRow(a.childRunId);
    // [r8 §3] company 는 요청값 바인딩 — 발견된 자식의 company 로 대체되지 않는다.
    expect(await workflowService.cancelRun(db, { runId: a.childRunId, companyId: b.companyId })).toBe(false);
    const aid = await identityOf(a);
    const swaps: Array<[keyof ChildStartIdentity, unknown]> = [
      ["companyId", b.companyId], ["parentRunId", b.parentRunId], ["parentStepRunId", b.stepRunId],
      ["invocationId", b.invocationId], ["childRunId", b.childRunId], ["stepId", "other-step"], ["generation", 2],
    ];
    for (const [key, value] of swaps) {
      expect(await claimDirectlyCancelledLinkedChildRun(db, { ...aid, [key]: value } as ChildStartIdentity))
        .toEqual({ outcome: "cancelled", rows: [] });
    }
    expect(await runRow(a.childRunId)).toEqual(before);
    expect((await runRow(b.childRunId)).status).toBe("running");
    const retryCount = await linkedLive("R8 RaceRetry", { retryCount: 1 });
    expect(await workflowService.cancelRun(db, { runId: retryCount.childRunId, companyId: retryCount.companyId })).toBe(false);
    const retryMeta = await linkedLive("R8 RaceRetryMeta", { retryMeta: true });
    expect(await workflowService.cancelRun(db, { runId: retryMeta.childRunId, companyId: retryMeta.companyId })).toBe(false);
    expect((await runRow(retryCount.childRunId)).status).toBe("running");
    expect((await runRow(retryMeta.childRunId)).status).toBe("running");
  });

  it("stale discovery and concurrent terminal transition refuse without writes — the final UPDATE re-evaluates the full binding under lock", async () => {
    // stale discovery — 발견과 writer 사이 C 가 종말화됨
    const stale = await linkedLive("R8 Stale");
    const staleId = await identityOf(stale);
    await db.update(workflowRuns).set({ status: "completed", childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, stale.childRunId));
    expect(await claimDirectlyCancelledLinkedChildRun(db, staleId)).toEqual({ outcome: "cancelled", rows: [] });
    expect((await runRow(stale.childRunId)).status).toBe("completed");
    // concurrent terminal transition — holder 가 C 를 잠그고 종말화, writer 대기 → 잠금 하 최신 상태로 0행
    const x = await linkedLive("R8 Concurrent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.update(workflowRuns).set({ status: "completed", childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
      locked();
      await gate;
    });
    await lockedPromise;
    try {
      const pending = directCancel(x);
      expect(await observedLockWait()).toBe(true);
      release();
      expect(await pending).toEqual({ outcome: "cancelled", rows: [] });
    } finally {
      release();
      await holder;
    }
    expect((await runRow(x.childRunId)).status).toBe("completed");
  }, 20_000);

  it("owner delayed materialization after direct cancellation refuses without writes — typed ineligible start and fenced materializer not-owner; terminal C never reopened", async () => {
    const x = await linkedLive("R8 Delayed", { lease: true });
    const fenceIdentity = await identityOf(x);
    expect(await workflowService.cancelRun(db, { runId: x.childRunId, companyId: x.companyId })).toBe(true);
    const before = await runRow(x.childRunId);
    expect((await executeWorkflowRunWithStartOutcome(db, x.childRunId)).kind).toBe("ineligible");
    const fenced = await ensureWorkflowStepRunRecords(db, {
      runId: x.childRunId,
      steps: [{ id: "child-a" }],
      childStartFence: { identity: fenceIdentity, token: x.token! },
      buildMetadata: () => ({}),
      syncControls: async (_db, rows) => rows,
    });
    expect(fenced.kind).toBe("not-owner");
    expect(await runRow(x.childRunId)).toEqual(before);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId))).toHaveLength(0);
  });
});
