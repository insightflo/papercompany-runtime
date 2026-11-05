import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, missions, workflowRuns, workflowStepInvocations, workflowStepRuns, workflowDefinitions, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun, insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";
import {
  discoverLegacyStructuralScope, withWorkflowToolLockScope,
  type ExpectedWorkflowToolScope,
} from "../services/workflow/workflow-tool-lock-scope.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const plainStep = { id: "one", name: "One", type: "tool", dependencies: [], toolNames: ["plugin:one"] };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; missionId: string; runId: string; parentRunId: string;
  parentStepRunId: string; childRunId: string; invocationId: string; targetWorkflowId: string;
  expected: ExpectedWorkflowToolScope;
};

async function fixture(kind: "plain" | "linked", withMission = true): Promise<Fixture> {
  const companyId = await createCompanyFixture(`lock-scope-${randomUUID()}`);
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "Scope", status: "active" }).returning();
  const targetWorkflowId = await insertDefinition({ companyId, name: "Target", steps: [plainStep] });
  const parentWorkflowId = kind === "linked"
    ? await insertDefinition({ companyId, name: "Parent", steps: [childStep(targetWorkflowId)] })
    : targetWorkflowId;
  const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId,
    stepId: kind === "linked" ? "run-child" : "one", stepStatus: "pending" });
  if (withMission || kind === "plain") await db.update(workflowRuns).set({ missionId: mission!.id }).where(eq(workflowRuns.id, parent.runId));
  if (kind === "plain") {
    await insertStepRunForRun({ runId: parent.runId, stepId: "z" });
    await insertStepRunForRun({ runId: parent.runId, stepId: "a" });
    return {
      companyId, missionId: mission!.id, runId: parent.runId, parentRunId: "", parentStepRunId: "",
      childRunId: parent.runId, invocationId: "", targetWorkflowId,
      expected: { kind: "plain", companyId, workflowRunId: parent.runId, missionId: mission!.id },
    };
  }
  const linked = await insertLinkedInvocation(db, { companyId, parentRunId: parent.runId,
    parentStepRunId: parent.stepRunId, childWorkflowId: targetWorkflowId, stepId: "run-child" });
  await insertStepRunForRun({ runId: linked.childRunId, stepId: "z" });
  await insertStepRunForRun({ runId: linked.childRunId, stepId: "a" });
  return {
    companyId, missionId: mission!.id, runId: linked.childRunId, parentRunId: parent.runId,
    parentStepRunId: parent.stepRunId, childRunId: linked.childRunId, invocationId: linked.invocationId,
    targetWorkflowId,
    expected: { kind: "linked", companyId, workflowRunId: linked.childRunId, missionId: null,
      identity: linked, parentMissionId: withMission ? mission!.id : null, targetWorkflowId },
  };
}

async function createMission(companyId: string, title: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title, status: "active" }).returning();
  return mission!;
}

type LockTable = "missions" | "workflow_runs" | "workflow_step_runs" | "workflow_step_invocations";

async function reserveRow(table: LockTable, id: string) {
  const client = await db.$client.reserve();
  await client.unsafe("begin");
  await client.unsafe(`select id from ${table} where id = $1::uuid for update`, [id]);
  const [{ pid }] = await client.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
  let released = false;
  return { pid, release: async () => {
    if (released) return;
    released = true;
    await client.unsafe("rollback").catch(() => {}); client.release();
  } };
}

function observeBackend(target: Db, onPid: (pid: number) => void): Db {
  return new Proxy(target, { get(dbTarget, key, receiver) {
    if (key === "transaction") return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      (dbTarget.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>)(async (tx) => {
        const [{ pid }] = await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
        onPid(pid); return callback(tx);
      }, config);
    const value = Reflect.get(dbTarget, key, receiver);
    return typeof value === "function" ? value.bind(dbTarget) : value;
  } }) as Db;
}

async function waitBlocked(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`select pg_blocking_pids(${waiter}::int) as blockers`) as unknown as Array<{ blockers: number[] }>;
    if (rows[0]?.blockers.includes(blocker)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${waiter} was not observed blocked by ${blocker}`);
}

async function tryLock(table: LockTable, id: string): Promise<boolean> {
  const client = await db.$client.reserve();
  try {
    await client.unsafe("begin");
    await client.unsafe(`select id from ${table} where id = $1::uuid for update nowait`, [id]);
    return true;
  } catch (error) { return (error as { code?: string }).code !== "55P03"; }
  finally { await client.unsafe("rollback").catch(() => {}); client.release(); }
}

function barrier() {
  let release!: () => void;
  let enter!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { waiting, entered, release, enter };
}

describePg("workflow raw tool lock scope", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-workflow-tool-scope-");
    db = createDb(temp.connectionString); configureWorkflowChildFixtures(db);
  }, 120_000);
  afterEach(async () => {
    for (const table of [workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, missions, agents, companies]) await db.delete(table);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("locks plain mission before run and sorted steps, with the established timeouts", async () => {
    const x = await fixture("plain"), blocker = await reserveRow("workflow_runs", x.runId), gate = barrier();
    let started!: (pid: number) => void;
    const pidPromise = new Promise<number>((resolve) => { started = resolve; });
    const pending = withWorkflowToolLockScope(observeBackend(db, started), x.expected, async (scope) => {
      gate.enter(); await gate.waiting;
      const settings = await scope.tx.execute(sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`) as unknown as Array<{ lock_timeout: string; statement_timeout: string }>;
      return { scope, settings: settings[0] };
    });
    try {
      const waiter = await pidPromise;
      await waitBlocked(waiter, blocker.pid);
      expect(await tryLock("missions", x.missionId)).toBe(false);
      await blocker.release();
      await gate.entered;
      expect(await tryLock("workflow_runs", x.runId)).toBe(false);
      for (const id of await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.runId))) {
        expect(await tryLock("workflow_step_runs", id.id)).toBe(false);
      }
    } finally { await blocker.release(); gate.release(); }
    const result = await pending;
    expect(result.scope.scopeIssue).toBeNull();
    expect(result.scope.steps.map((step) => step.stepId)).toEqual(["a", "one", "z"]);
    expect(result.settings).toEqual({ lock_timeout: "500ms", statement_timeout: "5s" });
  });

  it("locks linked mission then expected P/I/S/C before sorted child steps", async () => {
    const x = await fixture("linked"), blocker = await reserveRow("workflow_runs", x.childRunId), gate = barrier();
    let started!: (pid: number) => void;
    const pidPromise = new Promise<number>((resolve) => { started = resolve; });
    const pending = withWorkflowToolLockScope(observeBackend(db, started), x.expected, async (scope) => {
      gate.enter(); await gate.waiting; return scope;
    });
    try {
      const waiter = await pidPromise;
      await waitBlocked(waiter, blocker.pid);
      for (const [table, id] of [["missions", x.missionId], ["workflow_runs", x.parentRunId],
        ["workflow_step_invocations", x.invocationId], ["workflow_step_runs", x.parentStepRunId]] as const) {
        expect(await tryLock(table, id), `${table} must precede child run`).toBe(false);
      }
      await blocker.release();
      await gate.entered;
      expect(await tryLock("workflow_runs", x.childRunId)).toBe(false);
    } finally { await blocker.release(); gate.release(); }
    const result = await pending;
    expect(result.scopeIssue).toBeNull();
    expect(result.steps.map((step) => step.stepId)).toEqual(["a", "z"]);
    expect(result.child).toMatchObject({ parent: { id: x.parentRunId }, invocation: { id: x.invocationId },
      parentStep: { id: x.parentStepRunId }, child: { id: x.childRunId } });
  });

  it("discovers actual company and mission, keeps null parent missions, and holds broken child hints", async () => {
    const plain = await fixture("plain");
    expect(await discoverLegacyStructuralScope(db, { companyId: plain.companyId, workflowRunId: plain.runId }))
      .toEqual({ kind: "ready", expected: plain.expected });
    expect(await discoverLegacyStructuralScope(db, { companyId: randomUUID(), workflowRunId: plain.runId }))
      .toEqual({ kind: "held", reason: "legacy_run_missing_or_scope" });
    await db.update(workflowRuns).set({ triggeredBy: "workflow-step" }).where(eq(workflowRuns.id, plain.runId));
    expect(await discoverLegacyStructuralScope(db, { companyId: plain.companyId, workflowRunId: plain.runId }))
      .toEqual({ kind: "held", reason: "legacy_linked_identity_missing" });

    const linked = await fixture("linked", false);
    const discovered = await discoverLegacyStructuralScope(db, { companyId: linked.companyId, workflowRunId: linked.childRunId });
    expect(discovered).toEqual({ kind: "ready", expected: linked.expected });
    if (discovered.kind === "ready" && discovered.expected.kind === "linked") {
      expect(discovered.expected.parentMissionId).toBeNull();
      expect(discovered.expected.targetWorkflowId).toBe(linked.targetWorkflowId);
      expect(discovered.expected.identity).toMatchObject({ companyId: linked.companyId, parentRunId: linked.parentRunId,
        parentStepRunId: linked.parentStepRunId, invocationId: linked.invocationId, childRunId: linked.childRunId, generation: 1 });
    }
  });

  it("does not lock a new mission after plain or linked discovery scope changes", async () => {
    const plain = await fixture("plain"), replacement = await createMission(plain.companyId, "Replacement");
    const plainBarrier = barrier();
    await db.update(workflowRuns).set({ missionId: replacement!.id }).where(eq(workflowRuns.id, plain.runId));
    const plainPending = withWorkflowToolLockScope(db, plain.expected, async (scope) => { plainBarrier.enter(); await plainBarrier.waiting; return scope; });
    try {
      await plainBarrier.entered;
      expect(await tryLock("missions", replacement.id)).toBe(true);
    } finally { plainBarrier.release(); }
    expect((await plainPending).scopeIssue).toBe("run_mission_changed");

    const linked = await fixture("linked", false);
    const linkedDiscovery = await discoverLegacyStructuralScope(db, { companyId: linked.companyId, workflowRunId: linked.childRunId });
    expect(linkedDiscovery.kind).toBe("ready");
    if (linkedDiscovery.kind !== "ready") return;
    await db.update(workflowRuns).set({ missionId: linked.missionId }).where(eq(workflowRuns.id, linked.parentRunId));
    const linkedBarrier = barrier();
    const linkedPending = withWorkflowToolLockScope(db, linkedDiscovery.expected, async (raw) => {
      linkedBarrier.enter(); await linkedBarrier.waiting; return raw;
    });
    try {
      await linkedBarrier.entered;
      expect(await tryLock("missions", linked.missionId)).toBe(true);
    } finally { linkedBarrier.release(); }
    const scope = await linkedPending;
    expect(scope.scopeIssue).toBe("parent_mission_changed");
  });
});
