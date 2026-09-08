// @vitest-environment node
// [workflow-child r8 finding 4 — legal terminal gate + structured refusal] BUG#3 안전 반대:
// 무영수증 완료는 structured invalid-state + 감사 1건으로 거부(설계 r8 §4). 법정 경로 회귀,
// 잔여 임대 쌍, half-pair/aborted 스키마 거부, 사전 잠금 상태 변경, reconciler skip/recovered. 실제 hook+writer 만 호출하고 DB 상태만 단언한다.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileWorkflowChildStepWaits } from "../services/workflow/workflow-child-execution.js";
import { runWorkflowChildCompletionHook } from "../services/workflow/workflow-child-completion.js";
import { settleLinkedChildStepFromTerminal } from "../services/workflow/workflow-child-settlement-writers.js";
import { classifyIllegalTerminalChild } from "../services/workflow/workflow-child-settlement-support.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertChildStartLease, insertLinkedInvocation, insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; runId: string; stepRunId: string; childRunId: string;
  invocationId: string; childDefId: string; stepId: string;
};

/** linked(기본) 또는 materialized(영수증+옵션 스텝 행) 자식 + 완전 linked invocation fixture. */
async function childFixture(
  name: string,
  opts: { childStatus?: string; materialized?: boolean; childStepIds?: string[]; adopted?: boolean; extraChildStep?: boolean } = {},
): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: `${name}-child`,
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const link = {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus: opts.childStatus,
  };
  const identity = opts.materialized
    ? await insertMaterializedChildRun(db, { ...link, stepIds: opts.childStepIds })
    : await insertLinkedInvocation(db, link);
  if (opts.extraChildStep) {
    await db.insert(workflowStepRuns).values({
      id: randomUUID(), workflowRunId: identity.childRunId, stepId: "a", status: "pending", retryCount: 0,
    });
  }
  if (opts.adopted) {
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId: identity.childRunId, invocationId: identity.invocationId, generation: 1 } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  return { companyId, runId, stepRunId, childRunId: identity.childRunId, invocationId: identity.invocationId, childDefId, stepId: identity.stepId };
}

const finishChild = (childRunId: string, status: string) =>
  db.update(workflowRuns).set({ status, completedAt: new Date() }).where(eq(workflowRuns.id, childRunId));
const stepRow = async (x: Fixture) =>
  (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0]!;
const childRow = async (x: Fixture) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId)))[0]!;

/** 완전 실행 스냅숏(P/S/I/C) — statuses, transition_version, metadata, timestamps 전부. */
async function executionSnapshot(x: Fixture, withChild = true): Promise<string> {
  const [parent, step, invocation, child] = await Promise.all([
    db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId)),
    db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)),
    db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, x.invocationId)),
    db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId)),
  ]);
  return JSON.stringify(withChild ? { parent: parent[0], step: step[0], invocation: invocation[0], child: child[0] }
    : { parent: parent[0], step: step[0], invocation: invocation[0] });
}

const refusalRows = (childRunId: string) => db.select().from(activityLog).where(and(
  eq(activityLog.action, "workflow_child.completion_refused_invalid_state"), eq(activityLog.entityId, childRunId),
));
const settle = (x: Fixture) => settleLinkedChildStepFromTerminal(db, {
  companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, stepId: x.stepId,
  invocationId: x.invocationId, childRunId: x.childRunId, generation: 1,
});
const hook = (x: Fixture, status: string) =>
  runWorkflowChildCompletionHook(db, { id: x.childRunId, companyId: x.companyId, status });
const invalidState = (reason: string) => ({
  outcome: "invalid-state", code: "workflow_child_invalid_state", version: 1, reason,
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

/**
 * 사전 잠금 상태 변경 게이트 — holder tx 가 writer 보다 먼저 C 를 patch 로 바꾸고 C 행 잠금을
 * 보유한다. writer 가 잠금 대기함을 관측한 뒤 holder 를 커밋하고 writer 결과를 돌려준다.
 */
async function settleUnderGate(x: Fixture, patch: Record<string, unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const holder = db.transaction(async (tx) => {
    await tx.update(workflowRuns).set(patch).where(eq(workflowRuns.id, x.childRunId));
    locked();
    await gate;
  });
  await lockedPromise;
  let pending!: ReturnType<typeof settle>;
  try {
    pending = settle(x);
    expect(await observedLockWait()).toBe(true);
  } finally {
    release();
    await holder;
  }
  return pending;
}

describeEmbeddedPostgres("workflow child r8 — completion legal terminal gate and structured refusal", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-receipt-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("BUG#3 opposite: completed without receipt and zero child steps is refused — invalid-state, hook false, one structured refusal, snapshot unchanged", async () => {
    const x = await childFixture("R8 NoReceipt", { childStatus: "completed" });
    const before = await executionSnapshot(x);
    expect(await settle(x)).toEqual(invalidState("completed_without_materialization_receipt"));
    const refusals = await refusalRows(x.childRunId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      companyId: x.companyId, actorType: "system", actorId: "workflow-step",
      entityType: "workflow_run", entityId: x.childRunId,
    });
    expect(refusals[0]!.details).toEqual({
      version: 1, code: "workflow_child_invalid_state", reason: "completed_without_materialization_receipt",
      parentRunId: x.runId, parentStepRunId: x.stepRunId, invocationId: x.invocationId,
    });
    expect(await hook(x, "completed")).toBe(false);
    expect(await refusalRows(x.childRunId)).toHaveLength(2);
    expect(await executionSnapshot(x)).toBe(before);
  });

  it("refusal precedence: completed without receipt keeps its reason even with child step rows; non-success terminal with rows yields child_steps reason", async () => {
    const completed = await childFixture("R8 PrecCompleted", { childStatus: "completed", extraChildStep: true });
    expect(await settle(completed)).toEqual(invalidState("completed_without_materialization_receipt"));
    const failed = await childFixture("R8 PrecFailed", { childStatus: "failed", extraChildStep: true });
    expect(await settle(failed)).toEqual(invalidState("child_steps_without_materialization_receipt"));
    expect(await refusalRows(failed.childRunId)).toHaveLength(1);
    expect((await stepRow(failed)).status).toBe("pending");
  });

  it("receipted completed with zero child rows settles once via hook; repeat call is a no-op", async () => {
    const x = await childFixture("R8 EmptyOk", { childStatus: "completed", materialized: true, childStepIds: [] });
    expect(await hook(x, "completed")).toBe(true);
    const step = await stepRow(x);
    expect(step.status).toBe("completed");
    expect((step.metadata as Record<string, unknown>).toolResult).toMatchObject({
      success: true, exitCode: 0, data: { ok: true, childRunId: x.childRunId, childStatus: "completed" },
    });
    expect((await settle(x)).outcome).toBe("no-op");
    expect(await hook(x, "completed")).toBe(false);
  });

  it("receipted completed with child step rows settles the pending parent step", async () => {
    const x = await childFixture("R8 RowsOk", { childStatus: "completed", materialized: true });
    expect(await hook(x, "completed")).toBe(true);
    const step = await stepRow(x);
    expect(step.status).toBe("completed");
    expect(step.metadata).toMatchObject({ toolResult: { success: true, data: { ok: true } } });
  });

  it("all DB-legal non-success terminals with receipt still settle as failures (existing contract)", async () => {
    // aborted/timed-out 은 0046 workflow_runs_status_check 로 영속 불가 — 별도 제약 신용 테스트.
    for (const status of ["failed", "cancelled"]) {
      const x = await childFixture(`R8 Term ${status}`, { childStatus: status, materialized: true });
      expect(await hook(x, status)).toBe(true);
      const step = await stepRow(x);
      expect(step.status).toBe("failed");
      expect((step.metadata as Record<string, unknown>).toolResult).toMatchObject({
        success: false,
        error: status === "cancelled" ? "child_run_cancelled" : "child_run_failed",
        data: { ok: false, childRunId: x.childRunId, childStatus: status },
      });
    }
  });

  it("aborted/timed-out fixtures are schema-rejected (status CHECK) and the classifier still covers them at unit level", async () => {
    for (const status of ["aborted", "timed-out"]) {
      await expect(childFixture(`R8 Illegal ${status}`, { childStatus: status })).rejects.toThrow(/workflow_runs_status_check/);
      expect(classifyIllegalTerminalChild({ status, childStartToken: null, childStartLeaseExpiresAt: null, childStartMaterializedAt: null }, 1))
        .toBe("child_steps_without_materialization_receipt");
    }
  });

  it("failed initialization without receipt and zero rows remains legal failure settlement", async () => {
    const x = await childFixture("R8 FailedInit", { childStatus: "failed" });
    expect(await hook(x, "failed")).toBe(true);
    const step = await stepRow(x);
    expect(step.status).toBe("failed");
    expect((step.metadata as Record<string, unknown>).toolResult).toMatchObject({ success: false, error: "child_run_failed" });
    expect(await refusalRows(x.childRunId)).toHaveLength(0);
  });

  it("every persistable terminal with a leftover token/lease pair is refused as terminal_child_has_start_lease", async () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      for (const mode of ["active", "expired-lease", "expired-deadline"] as const) {
        const x = await childFixture(`R8 Lease ${status} ${mode}`,
          status === "completed" ? { childStatus: status, materialized: true, childStepIds: [] } : { childStatus: status });
        await insertChildStartLease(db, { childRunId: x.childRunId, mode });
        await finishChild(x.childRunId, status);
        expect(await settle(x)).toEqual(invalidState("terminal_child_has_start_lease"));
        expect(await refusalRows(x.childRunId)).toHaveLength(1);
        const step = await stepRow(x);
        expect(step.status).toBe("pending");
        expect(step.metadata).not.toMatchObject({ toolResult: expect.anything() });
      }
    }
  });

  it("half start pair (token without lease) is schema-rejected — separate constraint credit, not invalid-state", async () => {
    const x = await childFixture("R8 HalfPair", { childStatus: "completed" });
    await expect(db.update(workflowRuns).set({ childStartToken: randomUUID() })
      .where(eq(workflowRuns.id, x.childRunId)))
      .rejects.toThrow(/workflow_runs_child_start_lease_pair_ck/);
    expect(await refusalRows(x.childRunId)).toHaveLength(0);
    expect((await stepRow(x)).status).toBe("pending");
  });

  it("concurrent pre-lock receipt write: verdict follows locked current state (invalid snapshot settles)", async () => {
    const x = await childFixture("R8 RaceWin", { childStatus: "completed" });
    expect((await settleUnderGate(x, { childStartMaterializedAt: new Date() })).outcome).toBe("settled");
    expect((await stepRow(x)).status).toBe("completed");
    expect((await childRow(x)).childStartMaterializedAt).not.toBeNull();
    expect(await refusalRows(x.childRunId)).toHaveLength(0);
  });

  it("concurrent pre-lock receipt clear: loser refuses on locked state and preserves all rows", async () => {
    const x = await childFixture("R8 RaceLose", { childStatus: "completed", materialized: true, childStepIds: [] });
    const before = await executionSnapshot(x, false);
    const pending = settleUnderGate(x, { childStartMaterializedAt: null });
    expect(await pending).toEqual(invalidState("completed_without_materialization_receipt"));
    expect(await hook(x, "completed")).toBe(false);
    expect(await executionSnapshot(x, false)).toBe(before);
    const child = await childRow(x);
    expect(child.status).toBe("completed");
    expect(child.childStartMaterializedAt).toBeNull();
    expect(await refusalRows(x.childRunId)).toHaveLength(2);
  });

  it("reconciler over invalid completed child: bounded skipped, no recovered claim, execution rows unchanged", async () => {
    const x = await childFixture("R8 RecInvalid", { childStatus: "completed", adopted: true });
    const before = await executionSnapshot(x);
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 10 });
    const mine = results.filter((r) => r.stepRunId === x.stepRunId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.action).toBe("skipped");
    expect(mine[0]!.reason).toBe("terminal child but step not completable");
    expect(results.every((r) => r.action !== "recovered")).toBe(true);
    expect(await executionSnapshot(x)).toBe(before);
  });

  it("reconciler regression: receipted completed child settles the pending step exactly once (recovered)", async () => {
    const x = await childFixture("R8 RecOk", { childStatus: "completed", materialized: true, childStepIds: [], adopted: true });
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 10 });
    const mine = results.filter((r) => r.stepRunId === x.stepRunId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.action).toBe("recovered");
    const step = await stepRow(x);
    expect(step.status).toBe("completed");
    expect(step.metadata).toMatchObject({ toolResult: { success: true } });
    const again = await reconcileWorkflowChildStepWaits(db, { limit: 10 });
    expect(again.filter((r) => r.stepRunId === x.stepRunId)).toHaveLength(0);
  });
});
