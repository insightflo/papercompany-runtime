// @vitest-environment node
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, missions, workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun, insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import {
  encodeRetainedToolRequest, requestForRow, validRequest,
  type OriginalWorkflowAuthority, type RetainedToolRequest, type SpecializedToolAuthority,
} from "../services/plugin-tool-receipt-envelope.js";
import { withSpecializedToolAuthority } from "../services/workflow/specialized-tool-authority.js";
import { lockChildStartIdentityRows, withLockedChildStartIdentity, type WorkflowTx } from "../services/workflow/workflow-child-start-state.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const gateSpec = { id: "gate", name: "Gate", type: "tool", qaType: "structural", toolNames: ["plugin:gate"], dependencies: ["producer"] };
const producerSpec = { id: "producer", name: "Producer", type: "tool", toolNames: ["plugin:producer"], dependencies: [] };
const token = { producerStepId: "producer", iterationIndex: 4, completedAt: "2026-10-28T12:00:00.000Z" };
const acceptedAt = "2026-10-29T00:00:00.000Z";
const params = { text: "value" };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; missionId: string; parentRunId: string; parentStepRunId: string;
  childRunId: string; invocationId: string; ownerStepRunId: string; targetWorkflowId: string;
  owner: RetainedToolRequest;
};

async function createMission(companyId: string): Promise<string> {
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [row] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "Authority", status: "active" }).returning();
  return row!.id;
}

function marker(owner: RetainedToolRequest) {
  return { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
    tool: owner.tool, workflow: owner.workflow, claim: { status: "claimed", claimedAt: owner.workflow!.acceptedAt } };
}

async function fixture(kind: "plain" | "linked" = "linked"): Promise<Fixture> {
  const companyId = await createCompanyFixture(`specialized-${kind}`), missionId = await createMission(companyId);
  const targetWorkflowId = await insertDefinition({ companyId, name: "Tool workflow", steps: [producerSpec, gateSpec] });
  const parentWorkflowId = kind === "linked"
    ? await insertDefinition({ companyId, name: "Parent", steps: [childStep(targetWorkflowId)] })
    : targetWorkflowId;
  const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId,
    stepId: kind === "linked" ? "run-child" : "producer", stepStatus: kind === "linked" ? "pending" : "completed" });
  await db.update(workflowRuns).set({ missionId }).where(eq(workflowRuns.id, parent.runId));
  let childRunId = parent.runId, invocationId = "", ownerStepRunId = "", parentStepRunId = parent.stepRunId;
  if (kind === "linked") {
    const child = await insertMaterializedChildRun(db, { companyId, parentRunId: parent.runId,
      parentStepRunId: parent.stepRunId, childWorkflowId: targetWorkflowId, stepIds: ["producer", "gate"] });
    childRunId = child.childRunId; invocationId = child.invocationId;
    parentStepRunId = child.parentStepRunId;
    ownerStepRunId = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRunId)))
      .find((row) => row.stepId === "gate")!.id;
  } else ownerStepRunId = await insertStepRunForRun({ runId: parent.runId, stepId: "gate", status: "running" });
  const requestId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", iterationIndex: 2, executionGeneration: 2,
    lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt),
  }).where(eq(workflowStepRuns.id, ownerStepRunId));
  const [ownerStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, ownerStepRunId));
  const linkedChild = kind === "linked" ? { identity: { companyId, parentRunId: parent.runId, parentStepRunId,
    stepId: "run-child", invocationId, childRunId, generation: 1 as const }, targetWorkflowId, parentMissionId: missionId } : null;
  const specialized: SpecializedToolAuthority = { structural: { producerToken: token, iterationIndex: 2, completedAt: null }, linkedChild };
  const workflow: OriginalWorkflowAuthority = { missionId: kind === "linked" ? null : missionId, workflowRunId: childRunId,
    stepRunId: ownerStepRunId, stepId: "gate", requestId, executionGeneration: 2,
    statusTransitionVersion: ownerStep!.statusTransitionVersion, runStatus: "running", stepStatus: "running", acceptedAt, specialized };
  const owner: RetainedToolRequest = { kind: "paperclip.retained-tool-request", version: 1, receiptId: randomUUID(),
    consumer: "workflow", companyId, tool: "plugin:gate", parameters: params,
    identity: { runId: randomUUID(), idempotencyKey: randomUUID() }, workflow };
  const invocation = { requestId: workflow.requestId, toolName: owner.tool, args: params, retainedCompletion: marker(owner) };
  await db.update(workflowStepRuns).set({
    metadata: { structuralGateProducerToken: token, toolQueue: { status: "claimed", claimedAt: acceptedAt }, toolInvocation: invocation },
  }).where(eq(workflowStepRuns.id, ownerStepRunId));
  return { companyId, missionId, parentRunId: parent.runId, parentStepRunId, childRunId, invocationId,
    ownerStepRunId, targetWorkflowId, owner };
}

async function reserveRow(table: "workflow_runs" | "workflow_step_runs" | "workflow_step_invocations", id: string) {
  const client = await db.$client.reserve();
  await client.unsafe("begin");
  await client.unsafe(`select id from ${table} where id = $1::uuid for update`, [id]);
  const [{ pid }] = await client.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
  return { pid, release: async () => { await client.unsafe("rollback").catch(() => {}); client.release(); } };
}

function observeBackend(target: ReturnType<typeof createDb>, onPid: (pid: number) => void): Db {
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

async function tryLock(table: "missions" | "workflow_runs" | "workflow_step_runs" | "workflow_step_invocations", id: string): Promise<boolean> {
  const client = await db.$client.reserve();
  try {
    await client.unsafe("begin");
    await client.unsafe(`select id from ${table} where id = $1::uuid for update nowait`, [id]);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "55P03";
  } finally { await client.unsafe("rollback").catch(() => {}); client.release(); }
}

describePg("unused specialized tool authority S1", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-specialized-authority-");
    db = createDb(temp.connectionString); configureWorkflowChildFixtures(db);
  }, 120_000);
  afterEach(async () => {
    for (const table of [workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, missions, agents, companies]) await db.delete(table);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("keeps ordinary v1 requests valid and round-trips strict combined capture with NUL parameters", () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const workflow: OriginalWorkflowAuthority = { missionId: null, workflowRunId: ids[0]!, stepRunId: ids[1]!, stepId: "gate",
      requestId: "request", executionGeneration: 1, statusTransitionVersion: 0, runStatus: "running", stepStatus: "running", acceptedAt };
    const base: RetainedToolRequest = { kind: "paperclip.retained-tool-request", version: 1, receiptId: ids[2]!,
      consumer: "workflow", companyId: ids[3]!, tool: "plugin:gate", parameters: { text: "nul\u0000value" },
      identity: { runId: "run", idempotencyKey: "key" }, workflow };
    expect(validRequest(base)).toBe(true);
    const combined: RetainedToolRequest = { ...base, workflow: { ...workflow, specialized: {
      structural: { producerToken: token, iterationIndex: 2, completedAt: null },
      linkedChild: { identity: { companyId: ids[3]!, parentRunId: ids[4]!, parentStepRunId: ids[5]!,
        stepId: "run-child", invocationId: randomUUID(), childRunId: workflow.workflowRunId, generation: 1 },
        targetWorkflowId: randomUUID(), parentMissionId: null },
    } } };
    const encoded = encodeRetainedToolRequest(combined);
    expect(requestForRow({ id: combined.receiptId, companyId: combined.companyId, runId: combined.identity.runId,
      tool: combined.tool, idempotencyKey: combined.identity.idempotencyKey, requestParameters: encoded })).toEqual(combined);
    const captured = combined.workflow!.specialized!;
    const malformed = { ...combined, workflow: { ...combined.workflow!, specialized: {
      ...captured, structural: { ...captured.structural!, unknown: true },
    } } };
    expect(validRequest(malformed)).toBe(false);
    expect(validRequest({ ...base, workflow: { ...workflow, specialized: { linkedChild: null } } })).toBe(false);
    const badGeneration = { ...combined, workflow: { ...combined.workflow!, specialized: { ...captured,
      linkedChild: { ...captured.linkedChild!, identity: { ...captured.linkedChild!.identity, generation: 2 } },
    } } };
    expect(validRequest(badGeneration)).toBe(false);
  });

  it("locks mission before the plain run, then all steps by (stepId,id), with bounded timeouts", async () => {
    const x = await fixture("plain"), blocker = await reserveRow("workflow_runs", x.childRunId);
    let started!: (pid: number) => void; const pidPromise = new Promise<number>((resolve) => { started = resolve; });
    const observed = observeBackend(db, started);
    const pending = withSpecializedToolAuthority(observed, x.owner, async (scope) => {
      const timeouts = await scope.tx.execute(sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`) as unknown as Array<{ lock_timeout: string; statement_timeout: string }>;
      return { classification: await scope.classify(), timeouts: timeouts[0], stepIds: scope.steps.map((row) => row.stepId) };
    });
    const waiter = await pidPromise;
    try { await waitBlocked(waiter, blocker.pid); expect(await tryLock("missions", x.missionId)).toBe(false); }
    finally { await blocker.release(); }
    const result = await pending;
    expect(result.classification.authority).toEqual({ kind: "current" });
    expect(result.timeouts).toEqual({ lock_timeout: "500ms", statement_timeout: "5s" });
    expect(result.stepIds).toEqual([...result.stepIds].sort());
  });

  it("locks parent mission then P/I/S/C and child steps; malformed or changed evidence stays typed", async () => {
    const x = await fixture("linked"), blocker = await reserveRow("workflow_runs", x.childRunId);
    let started!: (pid: number) => void; const pidPromise = new Promise<number>((resolve) => { started = resolve; });
    const pending = withSpecializedToolAuthority(observeBackend(db, started), x.owner, async (scope) => ({
      classification: await scope.classify(), order: scope.steps.map((row) => row.stepId), child: scope.child,
    }));
    const waiter = await pidPromise;
    try {
      await waitBlocked(waiter, blocker.pid);
      for (const [table, id] of [["missions", x.missionId], ["workflow_runs", x.parentRunId],
        ["workflow_step_invocations", x.invocationId], ["workflow_step_runs", x.parentStepRunId]] as const) {
        expect(await tryLock(table, id), `${table} must precede C`).toBe(false);
      }
    } finally { await blocker.release(); }
    const first = await pending;
    expect(first.classification.authority).toEqual({ kind: "current" });
    expect(first.order).toEqual(["gate", "producer"]);
    expect(first.child).toMatchObject({ parent: { id: x.parentRunId }, invocation: { id: x.invocationId }, child: { id: x.childRunId } });

    const check = async () => withSpecializedToolAuthority(db, x.owner, async (scope) => (await scope.classify()).authority);
    await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, x.parentStepRunId));
    expect(await check()).toEqual({ kind: "lost", reason: "parent_step_not_current" });
    await db.update(workflowStepRuns).set({ retryCount: 0, metadata: { workflowRetry: null } }).where(eq(workflowStepRuns.id, x.parentStepRunId));
    expect(await check()).toEqual({ kind: "lost", reason: "parent_step_not_current" });
    await db.update(workflowStepRuns).set({ retryCount: 0, metadata: {} }).where(eq(workflowStepRuns.id, x.parentStepRunId));
    const alternate = await insertDefinition({ companyId: x.companyId, name: "Alternate", steps: [producerSpec, gateSpec] });
    await db.update(workflowRuns).set({ workflowId: alternate }).where(eq(workflowRuns.id, x.childRunId));
    expect(await check()).toEqual({ kind: "lost", reason: "child_target_changed" });
    await db.update(workflowRuns).set({ workflowId: x.targetWorkflowId, childStartMaterializedAt: null }).where(eq(workflowRuns.id, x.childRunId));
    expect(await check()).toEqual({ kind: "held", reason: "child_not_materialized" });
    const legacy = { ...x.owner, workflow: { ...x.owner.workflow } } as RetainedToolRequest;
    delete legacy.workflow!.specialized;
    expect(await withSpecializedToolAuthority(db, legacy, async (scope) => (await scope.classify()).authority))
      .toEqual({ kind: "held", reason: "specialization_capture_missing" });
  });

  it("holds QA artifact steps without a verified receipt", async () => {
    const x = await fixture("plain"), check = () => withSpecializedToolAuthority(db, x.owner, async (scope) => (await scope.classify()).authority);
    await db.update(workflowDefinitions).set({ stepsJson: [producerSpec, { ...gateSpec, toolArtifactContract: {
      role: "qa", schemaVersion: "example.result.v2", inputStepId: "producer",
    } }] }).where(eq(workflowDefinitions.id, x.targetWorkflowId));
    expect(await check()).toEqual({ kind: "held", reason: "verified_qa_receipt_required" });
    await db.update(workflowDefinitions).set({ stepsJson: [producerSpec, gateSpec] }).where(eq(workflowDefinitions.id, x.targetWorkflowId));
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.ownerStepRunId));
    await db.update(workflowStepRuns).set({ metadata: { ...(step!.metadata as Record<string, unknown>), toolArtifactRequest: null } })
      .where(eq(workflowStepRuns.id, x.ownerStepRunId));
    expect(await check()).toEqual({ kind: "held", reason: "verified_qa_receipt_required" });
  });

  it("keeps a missionless immediate parent current and holds a changed mission", async () => {
    const x = await fixture("linked"), linked = x.owner.workflow!.specialized!.linkedChild!;
    const owner = { ...x.owner, workflow: { ...x.owner.workflow!, specialized: {
      ...x.owner.workflow!.specialized!, linkedChild: { ...linked, parentMissionId: null },
    } } } as RetainedToolRequest;
    await db.update(workflowRuns).set({ missionId: null }).where(eq(workflowRuns.id, x.parentRunId));
    const invocation = { requestId: owner.workflow!.requestId, toolName: owner.tool, args: owner.parameters, retainedCompletion: marker(owner) };
    await db.update(workflowStepRuns).set({ metadata: { structuralGateProducerToken: token,
      toolQueue: { status: "claimed", claimedAt: acceptedAt }, toolInvocation: invocation,
    } }).where(eq(workflowStepRuns.id, x.ownerStepRunId));
    const check = () => withSpecializedToolAuthority(db, owner, async (scope) => ({ state: await scope.classify(), mission: scope.mission }));
    const current = await check();
    expect(current.state.authority).toEqual({ kind: "current" });
    expect(current.state.mission).toBeNull();
    await db.update(workflowRuns).set({ missionId: x.missionId }).where(eq(workflowRuns.id, x.parentRunId));
    expect((await check()).state.authority).toEqual({ kind: "held", reason: "parent_mission_changed" });
  });

  it("raw expected-ID locking continues P→I→S→C after a missing P and strict validation stays nullable", async () => {
    const x = await fixture("linked"), blocker = await reserveRow("workflow_runs", x.childRunId);
    let started!: (pid: number) => void; const pidPromise = new Promise<number>((resolve) => { started = resolve; });
    const wrong = { companyId: x.companyId, parentRunId: randomUUID(), parentStepRunId: x.parentStepRunId,
      stepId: "run-child", invocationId: x.invocationId, generation: 1, childRunId: x.childRunId };
    const observed = observeBackend(db, started);
    const pending = observed.transaction(async (tx) => lockChildStartIdentityRows(tx as unknown as WorkflowTx, wrong));
    const waiter = await pidPromise;
    try {
      await waitBlocked(waiter, blocker.pid);
      expect(await tryLock("workflow_step_invocations", x.invocationId)).toBe(false);
      expect(await tryLock("workflow_step_runs", x.parentStepRunId)).toBe(false);
    } finally { await blocker.release(); }
    const raw = await pending;
    expect(raw).toMatchObject({ parent: null, invocation: { id: x.invocationId }, parentStep: { id: x.parentStepRunId }, child: { id: x.childRunId } });
    await expect(db.transaction(async (tx) => withLockedChildStartIdentity(tx as unknown as Db, { ...wrong, parentRunId: x.parentRunId, stepId: "wrong" })))
      .resolves.toBeNull();
  });

  it("strict child identity rejection returns before a blocked child row", async () => {
    const x = await fixture("linked"), blocker = await reserveRow("workflow_runs", x.childRunId);
    try {
      await expect(db.transaction(async (tx) => withLockedChildStartIdentity(tx as unknown as Db, {
        companyId: x.companyId, parentRunId: x.parentRunId, parentStepRunId: x.parentStepRunId,
        stepId: "wrong", invocationId: x.invocationId, generation: 1, childRunId: x.childRunId,
      }))).resolves.toBeNull();
    } finally { await blocker.release(); }
  });
});
