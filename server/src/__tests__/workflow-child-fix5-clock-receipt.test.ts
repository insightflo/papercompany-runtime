// @vitest-environment node
// [workflow-child fix5 — clock/receipt] DB-clock 권위+원자 영수증(설계 §2/§3), preparation 실패 정산,
// 진실한 결과. skew/그룹 OR/롤백/1회 영수증 통제 유지, descope v1 API 갱신: ChildStartIdentity 는
// stepId 포함 완전 신원, fence 는 identity+token 만(D3 — intent 삭제), run-start 는 3인자.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  executeWorkflowRunWithStartOutcome, setWorkflowToolStepExecutor, setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import {
  executeWorkflowRunStart, type WorkflowExecutionResultLite, type WorkflowRunStartHooks,
} from "../services/workflow/workflow-run-start.js";
import { ensureWorkflowStepRunRecords, type MaterializationInput } from "../services/workflow/workflow-step-materialization.js";
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import { failOwnedWorkflowChildStart } from "../services/workflow/workflow-child-start-failure.js";
import type { ChildStartIdentity } from "../services/workflow/workflow-child-start-state.js";
import { configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun } from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Owned = Awaited<ReturnType<typeof ownedToolChild>>;
const CHILD_STEPS = [{ id: "t", name: "T", type: "tool", dependencies: [] }];

/** 툴 스텝 자식 정의 + 링크된 자식 픽스처(fix4 ownedToolChild와 동일 계약 + invocationId). */
async function ownedToolChild(name: string): Promise<{
  companyId: string; runId: string; stepRunId: string; childRunId: string; childDefId: string; invocationId: string;
}> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: "child",
    steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
  });  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [{
    id: "run-child", name: "Run child workflow", type: "workflow", dependencies: [],
    targetWorkflowId: childDefId,
  }] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childRunId = randomUUID();
  const invocationId = randomUUID();
  await db.insert(workflowRuns).values({
    id: childRunId, workflowId: childDefId, companyId, status: "pending",
    triggeredBy: "workflow-step", triggerSource: "workflow",
    parentRunId: runId, parentStepRunId: stepRunId, rootRunId: runId,
  });
  await db.insert(workflowStepInvocations).values({
    id: invocationId, companyId, parentStepRunId: stepRunId, childRunId, generation: 1, state: "linked", targetWorkflowId: childDefId,
  });
  return { companyId, runId, stepRunId, childRunId, childDefId, invocationId };
}

const identityOf = (x: Owned): ChildStartIdentity => ({
  companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, stepId: "run-child",
  invocationId: x.invocationId, generation: 1, childRunId: x.childRunId,
});

function directMaterialize(x: Owned, token: string, overrides: Partial<MaterializationInput> = {}) {
  return ensureWorkflowStepRunRecords(db, {
    runId: x.childRunId, steps: CHILD_STEPS, childStartFence: { identity: identityOf(x), token },
    buildMetadata: (step) => ({ seeded: true, stepId: step.id }), syncControls: async (_d, rows) => rows,
    ...overrides,
  });
}

const runRow = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
const childRows = (x: Owned) => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
const childRow = async (x: Owned) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId)))[0];

function liteSnapshot(x: Owned): WorkflowExecutionResultLite {
  return { runId: x.childRunId, workflowId: x.childDefId, missionId: null, status: "running", completedAt: null, stepRuns: [] };
}
function startHooks(x: Owned, overrides: Partial<WorkflowRunStartHooks> = {}): WorkflowRunStartHooks {
  return {
    loadContext: async () => ({ run: { id: x.childRunId, companyId: x.companyId, status: "pending", missionId: null }, steps: [] }),
    assertToolsReady: async () => {}, validateStructural: async () => [],
    structuralTopologyErrors: () => [], activateMission: async () => ({}),
    sync: async () => ({ kind: "synced", result: liteSnapshot(x) }), snapshot: async () => liteSnapshot(x),
    childCompletionHook: vi.fn(async () => true),
    ...overrides,
  };
}

describeEmbeddedPostgres("workflow child fix5 — DB clock authority, atomic receipt, truthful outcomes", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix5-clock-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    vi.useRealTimers();
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    vi.restoreAllMocks();
    for (const table of [toolDefinitions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("(a) DB lease/deadline expiry (both, lease-only, deadline-only) rejected despite app clock -60s", async () => {
    for (const patch of [
      { childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`, childStartDeadlineAt: sql`clock_timestamp() - interval '1 second'` },
      { childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`, childStartDeadlineAt: sql`clock_timestamp() + interval '5 minutes'` },
      { childStartLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, childStartDeadlineAt: sql`clock_timestamp() - interval '1 second'` },
    ]) {
      const x = await ownedToolChild("F5 PartialExpiry");
      const token = randomUUID();
      await db.update(workflowRuns).set({
        childStartToken: sql`${token}::uuid`, status: "running", startedAt: new Date(), ...patch,
      }).where(eq(workflowRuns.id, x.childRunId));
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 60_000 });
      expect((await directMaterialize(x, token)).kind).toBe("not-owner");
      expect(await childRows(x)).toHaveLength(0);
      expect((await childRow(x))?.childStartMaterializedAt).toBeNull();
    }
  });

  it("(a) +60s application clock skew does not reject a DB-valid lease (no JS time authority)", async () => {
    const x = await ownedToolChild("F5 SkewAhead");
    const lease = await acquireWorkflowChildStartLease(db, identityOf(x));
    if (lease.kind !== "owned") throw new Error(`expected owned lease, got ${lease.kind}`);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    expect((await directMaterialize(x, lease.token)).kind).toBe("ready");
    expect((await childRow(x))?.childStartMaterializedAt).not.toBeNull();
    expect((await childRows(x)).filter((row) => row.stepId === "t")).toHaveLength(1);
  });

  it("(b) 250ms lease with 400ms pg_sleep inside the transaction rolls back rows, metadata and receipt", async () => {
    const x = await ownedToolChild("F5 TxExpiry");
    const token = randomUUID();
    await db.update(workflowRuns).set({
      childStartToken: sql`${token}::uuid`,
      childStartLeaseExpiresAt: sql`clock_timestamp() + interval '250 milliseconds'`,
      childStartDeadlineAt: sql`clock_timestamp() + interval '5 minutes'`,
      status: "running", startedAt: new Date(),
    }).where(eq(workflowRuns.id, x.childRunId));
    const outcome = await directMaterialize(x, token, {
      syncControls: async (syncDb, rows) => { await syncDb.execute(sql`select pg_sleep(0.4)`); return rows; },
    });
    expect(outcome.kind).toBe("not-owner");
    expect(await childRows(x)).toHaveLength(0);
    const child = await childRow(x);
    expect(child?.childStartMaterializedAt).toBeNull();
    expect(child?.childStartToken).not.toBeNull();
  });

  it("(c) concurrent takeover: held lock yields busy, then new token wins and the old token never writes", async () => {
    const x = await ownedToolChild("F5 Takeover");
    const oldToken = randomUUID();
    await db.update(workflowRuns).set({
      childStartToken: sql`${oldToken}::uuid`,
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      childStartDeadlineAt: sql`clock_timestamp() + interval '5 minutes'`,
      status: "running", startedAt: new Date(),
    }).where(eq(workflowRuns.id, x.childRunId));
    let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '5s', true)`);
      await tx.execute(sql`select id from workflow_runs where id = ${x.runId} for update`);
      locked();
      await gate;
    });
    await lockedPromise;
    try {
      expect((await acquireWorkflowChildStartLease(db, identityOf(x))).kind).toBe("busy");
    } finally {
      release();
      await holder;
    }
    const owned = await acquireWorkflowChildStartLease(db, identityOf(x));
    if (owned.kind !== "owned") throw new Error(`expected owned lease, got ${owned.kind}`);
    expect(owned.token).not.toBe(oldToken);
    expect((await directMaterialize(x, oldToken)).kind).toBe("not-owner");
    expect(await childRows(x)).toHaveLength(0);
    // 소유권 계열 전체 — 옛 토큰은 실패 정산 OWNER 변이의 권위도 없다(자동 전용, D3).
    expect((await failOwnedWorkflowChildStart(db, { identity: identityOf(x), token: oldToken, errorCode: "probe" })).kind).toBe("lost");
    expect((await childRow(x))?.childStartMaterializedAt).toBeNull();
  });

  it("(d) seeded receipt+token fixture is preserved byte-for-byte with no inserted step", async () => {
    const x = await ownedToolChild("F5 ReceiptFixture");
    const token = randomUUID();
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId: x.childRunId, stepId: "t", status: "pending" });
    await db.update(workflowRuns).set({
      childStartToken: sql`${token}::uuid`,
      childStartMaterializedAt: new Date(),
      childStartLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      childStartDeadlineAt: sql`clock_timestamp() + interval '5 minutes'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    const before = JSON.stringify({ child: await childRow(x), rows: await childRows(x) });
    expect((await directMaterialize(x, token)).kind).toBe("not-owner");
    expect(JSON.stringify({ child: await childRow(x), rows: await childRows(x) })).toBe(before);
  });

  it("(e) cancelled child generic sync leaves zero rows and the original terminal status", async () => {
    const x = await ownedToolChild("F5 CancelledGeneric");
    await db.update(workflowRuns).set({ status: "cancelled", completedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
    const outcome = await directMaterialize(x, "unused-generic-token", { childStartFence: undefined });
    expect(outcome.kind).toBe("not-owner");
    expect(await childRows(x)).toHaveLength(0);
    expect((await childRow(x))?.status).toBe("cancelled");
  });

  it("(f) empty definition receipt commits exactly once across normal entry and takeover sync", async () => {
    const x = await ownedToolChild("F5 EmptyReceipt");
    await db.update(workflowDefinitions).set({ stepsJson: [] }).where(eq(workflowDefinitions.id, x.childDefId));
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    await executeWorkflowRunWithStartOutcome(db, x.childRunId);
    const first = await childRow(x);
    expect(first?.childStartMaterializedAt).not.toBeNull();
    expect(first?.status).toBe("completed");
    await executeWorkflowRunWithStartOutcome(db, x.childRunId);
    const second = await childRow(x);
    expect(second?.childStartMaterializedAt?.getTime()).toBe(first?.childStartMaterializedAt?.getTime());
    expect(await childRows(x)).toHaveLength(0);
  });

  it("§5 preparation failures settle the owned child exactly once and rethrow the original error", async () => {
    const cases: Array<[string, RegExp, Partial<WorkflowRunStartHooks>]> = [
      ["readiness", /readiness boom/, { assertToolsReady: async () => { throw new Error("readiness boom"); } }],
      ["validation", /validation boom/, { validateStructural: async () => { throw new Error("validation boom"); } }],
      ["topology", /topology boom/, { structuralTopologyErrors: () => { throw new Error("topology boom"); } }],
      ["returned", /Structural gate validation failed/, { validateStructural: async () => ["bad shape"] }],
    ];
    for (const [label, message, overrides] of cases) {
      const x = await ownedToolChild(`F5 Prep ${label}`);
      const hooks = startHooks(x, overrides);
      await expect(executeWorkflowRunStart(db, x.childRunId, hooks)).rejects.toThrow(message);
      const child = await childRow(x);
      expect(child?.status, label).toBe("failed");
      expect(child?.completedAt, label).not.toBeNull();
      expect(child?.childStartToken, label).toBeNull();
      expect(child?.childStartLeaseExpiresAt, label).toBeNull();
      expect(child?.childStartDeadlineAt, label).not.toBeNull();
      expect((child?.metadata as Record<string, Record<string, unknown>>).workflowChildStartFailure, label)
        .toMatchObject({ version: 1, errorCode: "child_start_validation_failed" });
      expect(hooks.childCompletionHook, label).toHaveBeenCalledTimes(1);
      expect(vi.mocked(hooks.childCompletionHook).mock.calls[0][1], label).toMatchObject({ id: x.childRunId, status: "failed" });
    }
  });

  it("§5 expired-lease loser exception leaves winner bytes unchanged with zero loser hooks", async () => {
    const x = await ownedToolChild("F5 Loser");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let readinessEntries = 0;
    const hooks = startHooks(x, {
      assertToolsReady: async () => {
        readinessEntries += 1;
        if (readinessEntries === 1) { entered(); await gate; throw new Error("loser boom"); }
      },
    });
    const loser = executeWorkflowRunStart(db, x.childRunId, hooks).catch((error) => error);
    await entry;
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    expect((await executeWorkflowRunWithStartOutcome(db, x.childRunId)).kind).toBe("started");
    const before = JSON.stringify({ child: await childRow(x), rows: await childRows(x) });
    release();
    expect((await loser as Error).message).toBe("loser boom");
    expect(JSON.stringify({ child: await childRow(x), rows: await childRows(x) })).toBe(before);
    expect(hooks.childCompletionHook).not.toHaveBeenCalled();
  });

  it("cancelled child start returns a typed ineligible boundary and keeps its persisted rows", async () => {
    const x = await ownedToolChild("F5 CancelRefusal");
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId: x.childRunId, stepId: "t", status: "pending" });
    await db.update(workflowRuns).set({
      status: "cancelled", completedAt: new Date(), childStartToken: sql`${randomUUID()}::uuid`,
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    // [설계 §3] 취소/종말 자식은 typed ineligible 스냅숏 경계다(r2 CancelRace) — 평문 Error 는
    //   회복 경계에서 failed 로 오보된다. 지연 시작은 취소 행을 절대 되돌리지 않는다.
    const outcome = await executeWorkflowRunWithStartOutcome(db, x.childRunId);
    expect(outcome.kind).toBe("ineligible");
    expect(outcome.result.status).toBe("cancelled");
    expect(await childRows(x)).toHaveLength(1);
    expect((await childRow(x))?.status).toBe("cancelled");
  });
});
