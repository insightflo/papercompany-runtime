// @vitest-environment node
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, approvals, companies, createDb, missions, pluginToolExecutionReceipts, workflowDefinitions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTerminalDecisions,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { childStep, configureWorkflowChildFixtures, insertDefinition, insertRunWithWorkflowStepRun } from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { createJobRetention, createWorkerRpc, type ToolOutcome } from "../services/plugin-job-rpc.js";
import { observePluginTool, type ObservedToolExecution } from "../services/plugin-tool-observation.js";
import { TOOL_NAMESPACE_SEPARATOR, type RegisteredTool } from "../services/plugin-tool-registry.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import { bindRetainedWorkflowTool } from "../services/workflow/retained-tool-completion.js";
import { releaseRetainedWorkflowToolUnsent } from "../services/workflow/retained-tool-unsent-release.js";
import { stageRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import { ToolReceiptPersistenceError, type RetainedToolRequest } from "../services/plugin-tool-receipt-envelope.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const companyId = randomUUID(), agentId = randomUUID();
const acceptedAt = "2026-10-29T00:00:00.000Z", params = { query: "evidence" };
const producerToken = { producerStepId: "producer", iterationIndex: 4, completedAt: "2026-10-28T12:00:00.000Z" };
const actual: ToolOutcome = { kind: "result", result: { content: "done" }, response: { jsonrpc: "2.0", id: 1, result: { content: "done" } } };
type PositiveObservation = Extract<ObservedToolExecution, { kind: "definitely_unsent" | "deferred_before_start" }>;
type Seed = { runId: string; stepRunId: string; parentStepRunId?: string; scope: Parameters<typeof bindRetainedWorkflowTool>[1] };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
async function seed(options: { missionless?: boolean; structural?: boolean } = {}): Promise<Seed> {
  const missionId = options.missionless ? null : randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepRunId = randomUUID(), requestId = randomUUID();
  if (missionId) await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Mission", status: "active" });
  const definitions = [...(options.structural ? [{ id: "producer", name: "Producer", type: "tool", toolNames: ["plugin:producer"], dependencies: [] }] : []),
    { id: "tool", name: "Tool", agentId: "", type: "tool", toolNames: ["plugin:tool"], dependencies: options.structural ? ["producer"] : [], ...(options.structural ? { qaType: "structural" } : {}) }];
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Workflow", stepsJson: definitions });
  await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test" });
  if (options.structural) await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "producer", status: "completed", completedAt: new Date(producerToken.completedAt) });
  const metadata = { unrelated: { before: true }, ...(options.structural ? { structuralGateProducerToken: producerToken } : {}),
    toolQueue: { status: "claimed", claimedAt: acceptedAt }, toolInvocation: { requestId, toolName: "plugin:tool", args: params, dispatchedAt: acceptedAt, keep: "yes" } };
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId: "tool", status: "running", iterationIndex: 2,
    executionGeneration: 2, lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt), metadata });
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  return { runId, stepRunId, scope: { companyId, tool: "plugin:tool", parameters: params,
    workflow: { missionId, workflowRunId: runId, stepRunId, stepId: "tool", requestId, executionGeneration: 2, statusTransitionVersion: step!.statusTransitionVersion, runStatus: "running", stepStatus: "running", acceptedAt } } };
}

async function linkedSeed(): Promise<Seed> {
  const childWorkflowId = await insertDefinition({ companyId, name: "Child", steps: [{ id: "tool", name: "Tool", type: "tool", toolNames: ["plugin:tool"], dependencies: [] }] });
  const parentWorkflowId = await insertDefinition({ companyId, name: "Parent", steps: [childStep(childWorkflowId)] });
  const missionId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Parent mission", status: "active" });
  const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId, stepId: "run-child", stepStatus: "pending" });
  await db.update(workflowRuns).set({ missionId }).where(eq(workflowRuns.id, parent.runId));
  const child = await insertMaterializedChildRun(db, { companyId, parentRunId: parent.runId, parentStepRunId: parent.stepRunId, childWorkflowId, stepIds: ["tool"] });
  const stepRunId = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, child.childRunId)))[0]!.id;
  const requestId = randomUUID(), metadata = { toolQueue: { status: "claimed", claimedAt: acceptedAt }, toolInvocation: { requestId, toolName: "plugin:tool", args: params, dispatchedAt: acceptedAt } };
  await db.update(workflowStepRuns).set({ status: "running", iterationIndex: 0, executionGeneration: 2, lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt), metadata }).where(eq(workflowStepRuns.id, stepRunId));
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  return { runId: child.childRunId, stepRunId, parentStepRunId: parent.stepRunId, scope: { companyId, tool: "plugin:tool", parameters: params,
    workflow: { missionId: null, workflowRunId: child.childRunId, stepRunId, stepId: "tool", requestId, executionGeneration: 2, statusTransitionVersion: step!.statusTransitionVersion, runStatus: "running", stepStatus: "running", acceptedAt } } };
}

async function claim(s: Seed): Promise<RetainedToolRequest> { const result = await bindRetainedWorkflowTool(db, s.scope); if (result.kind !== "claim") throw new Error(`expected claim, got ${result.kind}`); return result.owner; }
async function step(s: Seed) { return (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId)))[0]!; }
async function receipt(owner: RetainedToolRequest) { return (await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId)))[0]; }
function observe(owner: RetainedToolRequest, shutdown = false) {
  const send = vi.fn(), rpc = createWorkerRpc({ pluginId: "plugin", pending: new Map(), canSend: () => false, send, defaultTimeoutMs: 10, maxTimeoutMs: 10, retention: createJobRetention() });
  const lifecycle = createRuntimeExecutionLifecycle(); if (shutdown) lifecycle.beginShutdown("SIGTERM");
  const tool: RegisteredTool = { pluginId: "plugin", pluginDbId: "plugin-db", name: "tool", namespacedName: owner.tool, displayName: "Tool", description: "test", parametersSchema: {} };
  const worker = { observeTool: (_id: string, input: Parameters<typeof rpc.observeTool>[0]) => rpc.observeTool(input) } as unknown as PluginWorkerManager;
  const full = observePluginTool({ namespacedName: owner.tool,
    parseName: (name) => { const i = name.lastIndexOf(TOOL_NAMESPACE_SEPARATOR); return i > 0 ? { pluginId: name.slice(0, i), toolName: name.slice(i + 1) } : null; },
    byNamespace: new Map([[owner.tool, tool]]), workerManager: worker, parameters: owner.parameters,
    runContext: { runId: owner.workflow!.workflowRunId } as unknown as ToolRunContext,
    identity: { requestId: owner.workflow!.requestId, executionId: owner.workflow!.workflowRunId, attemptId: owner.workflow!.stepRunId, executionGeneration: owner.workflow!.executionGeneration }, runtimeLifecycle: lifecycle });
  if (full.kind !== "definitely_unsent" && full.kind !== "deferred_before_start") throw new Error(`unexpected ${full.kind}`);
  return { proof: full as PositiveObservation, send };
}

function observedDb(target: Db, onPid: (pid: number) => void): Db {
  return new Proxy(target, { get(dbTarget, key, receiver) {
    if (key === "transaction") return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      (dbTarget.transaction.bind(dbTarget) as unknown as (cb: (tx: unknown) => Promise<unknown>, cfg?: unknown) => Promise<unknown>)(async (tx) => {
        const rows = await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(sql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
        onPid(rows[0]!.pid); return callback(tx);
      }, config);
    const value = Reflect.get(dbTarget, key, receiver);
    return typeof value === "function" ? value.bind(dbTarget) : value;
  } }) as Db;
}

async function reserve(table: "workflow_runs", id: string) {
  const client = await db.$client.reserve(); await client.unsafe("begin");
  await client.unsafe(`select id from ${table} where id = $1::uuid for update`, [id]);
  const [{ pid }] = await client.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
  return { pid, release: async () => { await client.unsafe("rollback").catch(() => {}); client.release(); } };
}
async function waitBlocked(waiter: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$client.unsafe("select pg_blocking_pids($1::int) as blockers", [waiter]) as unknown as { blockers: number[] }[];
    if (rows[0]?.blockers.includes(blocker)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${waiter} was not blocked by ${blocker}`);
}

async function addReplacementAuthority(runId: string) {
  const [source] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  const [decision] = await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: runId,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "test", discoveryPath: "test", origin: "test" }).returning();
  const [approval] = await db.insert(approvals).values({ companyId, type: "replacement", status: "approved", payload: {} }).returning(),
    [replacement] = await db.insert(workflowRuns).values({ companyId, workflowId: source!.workflowId, triggeredBy: "test" }).returning(),
    [event] = await db.insert(workflowTransitionEvents).values({ companyId, eventType: "replacement", layer: "test" }).returning();
  await db.insert(workflowRecoveryAuthorities).values({ companyId, workflowRunId: runId, targetAuthorityVersion: 0,
    resultingAuthorityVersion: 0, targetDecisionId: decision!.id, recoveryKind: "replacement_from_start_v1",
    requestedBy: "test", requestReference: randomUUID(), ownerDecisionEventId: event!.id, operatorApprovalId: approval!.id,
    replacementRunId: replacement!.id, requestHash: "a".repeat(64), replacementContract: {} });
}

describePg("retained workflow positive-unsent release on PostgreSQL", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("retained-unsent-release-"); db = createDb(temp.connectionString);
    configureWorkflowChildFixtures(db);
    await db.insert(companies).values({ id: companyId, name: "Retained unsent" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  }, 60_000);
  afterEach(async () => {
    if (!db) return;
    for (const table of [pluginToolExecutionReceipts, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, missions]) await db.delete(table);
  });
  afterAll(async () => { if (db) await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it.each([
    { label: "mission scoped", missionless: false, shutdown: false, structural: false },
    { label: "missionless", missionless: true, shutdown: true, structural: false },
    { label: "specialized structural", missionless: false, shutdown: false, structural: true },
  ])("releases only the exact $label attempt and preserves unrelated metadata", async ({ missionless, shutdown, structural }) => {
    const s = await seed({ missionless, structural }), owner = await claim(s), { proof, send } = observe(owner, shutdown);
    expect(owner.workflow!.specialized !== undefined).toBe(structural); expect(send).not.toHaveBeenCalled();
    expect((await receipt(owner))?.workflowRunId).toBeNull(); expect((await receipt(owner))?.stepId).toBeNull();
    const before = await step(s);
    await db.update(workflowStepRuns).set({ metadata: { ...before.metadata, unrelatedAfterBind: { keep: true } } }).where(eq(workflowStepRuns.id, s.stepRunId));
    const result = await releaseRetainedWorkflowToolUnsent(db, owner, proof);
    expect(result).toMatchObject({ kind: "released", receiptId: owner.receiptId, workflow: owner.workflow });
    const released = await step(s), invocation = released.metadata.toolInvocation as Record<string, unknown>;
    expect(released.status).toBe("running"); expect(released.lastDispatchAcceptedAt).toBeNull();
    expect(released.metadata.unrelatedAfterBind).toEqual({ keep: true });
    expect(released.metadata.toolQueue).toEqual({ status: "queued" });
    expect(invocation).toMatchObject({ requestId: owner.workflow!.requestId, toolName: owner.tool, args: params, keep: "yes" });
    expect(invocation.dispatchedAt).toBeUndefined(); expect(invocation.retainedCompletion).toBeUndefined();
    expect(await receipt(owner)).toBeUndefined();
    expect((await releaseRetainedWorkflowToolUnsent(db, owner, proof)).kind).toBe("held");

    const requestId = randomUUID(), nextAccepted = "2026-10-29T00:01:00.000Z", current = await step(s);
    const nextMetadata = { ...current.metadata, toolQueue: { status: "claimed", claimedAt: nextAccepted },
      toolInvocation: { ...invocation, requestId, dispatchedAt: nextAccepted } };
    await db.update(workflowStepRuns).set({ lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(nextAccepted),
      executionGeneration: current.executionGeneration + 1, metadata: nextMetadata }).where(eq(workflowStepRuns.id, s.stepRunId));
    const nextScope = { ...s.scope, workflow: { ...s.scope.workflow, requestId, acceptedAt: nextAccepted,
      executionGeneration: current.executionGeneration + 1 } };
    const next = await bindRetainedWorkflowTool(db, nextScope);
    if (next.kind !== "claim") throw new Error(`expected replay claim, got ${next.kind}`);
    const nextStep = await step(s), nextReceipt = await receipt(next.owner);
    expect((await releaseRetainedWorkflowToolUnsent(db, owner, proof)).kind).toBe("held");
    expect(await step(s)).toEqual(nextStep); expect(await receipt(next.owner)).toEqual(nextReceipt);
  });

  it("releases a linked-child claim only through its captured specialized authority", async () => {
    const s = await linkedSeed(), owner = await claim(s), { proof, send } = observe(owner);
    expect(owner.workflow!.specialized?.linkedChild).toBeTruthy(); expect(send).not.toHaveBeenCalled();
    expect((await releaseRetainedWorkflowToolUnsent(db, owner, proof)).kind).toBe("released");
    expect(await receipt(owner)).toBeUndefined(); expect((await step(s)).metadata.toolQueue).toEqual({ status: "queued" });
  });

  it.each(["request", "generation", "transition", "accepted", "structural", "linked", "mission", "replacement"] as const)("holds the original receipt when %s authority changes after bind", async (change) => {
      const s = change === "linked" ? await linkedSeed() : await seed({ structural: change === "structural" });
      const owner = await claim(s), { proof } = observe(owner);
      if (change === "request") await db.update(workflowStepRuns).set({ lastDispatchRequestId: randomUUID() }).where(eq(workflowStepRuns.id, s.stepRunId));
      else if (change === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, s.stepRunId));
      else if (change === "transition") await db.update(workflowStepRuns).set({ statusTransitionVersion: owner.workflow!.statusTransitionVersion + 1 }).where(eq(workflowStepRuns.id, s.stepRunId));
      else if (change === "accepted") await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: new Date("2026-10-29T00:02:00.000Z") }).where(eq(workflowStepRuns.id, s.stepRunId));
      else if (change === "structural") { const current = await step(s); await db.update(workflowStepRuns).set({ metadata: { ...current.metadata, structuralGateProducerToken: { ...producerToken, iterationIndex: 5 } } }).where(eq(workflowStepRuns.id, s.stepRunId)); }
      else if (change === "linked") await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, s.parentStepRunId!));
      else if (change === "mission") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.scope.workflow.missionId!));
      else await addReplacementAuthority(s.runId);
      const beforeStep = await step(s), beforeReceipt = await receipt(owner), beforeParent = change === "linked" ? await step({ ...s, stepRunId: s.parentStepRunId! }) : undefined;
      expect(beforeReceipt?.id).toBe(owner.receiptId); expect((beforeStep.metadata.toolInvocation as Record<string, unknown>).retainedCompletion).toBeDefined();
      expect((await releaseRetainedWorkflowToolUnsent(db, owner, proof)).kind).toBe("held");
      expect(await step(s)).toEqual(beforeStep); expect(await receipt(owner)).toEqual(beforeReceipt);
      if (beforeParent) expect(await step({ ...s, stepRunId: s.parentStepRunId! })).toEqual(beforeParent);
    });

  it("holds wrong route, wrong owner, wrong union, and nested deferral proof without writes", async () => {
    const s = await seed(), owner = await claim(s), { proof } = observe(owner, true), beforeStep = await step(s), beforeReceipt = await receipt(owner);
    const badRoute = { ...proof, toolName: "other" } as PositiveObservation;
    const badUnion = { ...proof, kind: "sent_or_unknown", observation: { kind: "sent_or_unknown" } } as unknown as PositiveObservation;
    const wrongOwner = { ...owner, identity: { ...owner.identity, idempotencyKey: randomUUID() } };
    const badDeferred = proof.kind === "deferred_before_start"
      ? { ...proof, deferredBeforeStart: { ...proof.deferredBeforeStart, requestId: randomUUID() } } as PositiveObservation : badUnion;
    for (const candidate of [
      [owner, badRoute], [wrongOwner, proof],
      [owner, badUnion], [owner, badDeferred],
    ] as const) expect((await releaseRetainedWorkflowToolUnsent(db, candidate[0], candidate[1])).kind).toBe("held");
    expect(await step(s)).toEqual(beforeStep); expect(await receipt(owner)).toEqual(beforeReceipt);
    expect((await observe(owner)).send).not.toHaveBeenCalled();
  });

  it("holds changed markers and every non-null outcome column", async () => {
    for (const changed of ["marker", "body", "json-null", "status", "completed"] as const) {
      const s = await seed(), owner = await claim(s), { proof } = observe(owner);
      if (changed === "marker") {
        const row = await step(s), metadata = { ...row.metadata }, invocation = { ...(row.metadata.toolInvocation as object) } as Record<string, unknown>;
        invocation.retainedCompletion = { ...(invocation.retainedCompletion as object), receiptId: randomUUID() };
        metadata.toolInvocation = invocation;
        await db.update(workflowStepRuns).set({ metadata }).where(eq(workflowStepRuns.id, s.stepRunId));
      } else if (changed === "body") await stageRetainedToolOutcome(db, owner, actual);
      else if (changed === "json-null") await db.$client.unsafe("UPDATE plugin_tool_execution_receipts SET result_body = 'null'::jsonb WHERE id = $1::uuid", [owner.receiptId]);
      else await db.update(pluginToolExecutionReceipts).set(changed === "status" ? { resultStatus: 200 } : { completedAt: new Date() })
        .where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
      const beforeStep = await step(s), beforeReceipt = await receipt(owner);
      expect((await releaseRetainedWorkflowToolUnsent(db, owner, proof)).kind).toBe("held");
      expect(await step(s)).toEqual(beforeStep); expect(await receipt(owner)).toEqual(beforeReceipt);
      if (changed === "json-null") expect((await db.$client.unsafe("SELECT result_body IS NULL AS sql_null FROM plugin_tool_execution_receipts WHERE id = $1::uuid", [owner.receiptId]))[0]?.sql_null).toBe(false);
    }
  });

  it("rolls the step update back when receipt delete throws or returns zero rows", async () => {
    const s = await seed(), owner = await claim(s), { proof } = observe(owner), beforeStep = await step(s), beforeReceipt = await receipt(owner);
    for (const mode of ["raise", "zero"] as const) {
      const body = mode === "raise" ? "RAISE EXCEPTION 'injected delete failure';" : "RETURN NULL;";
      await db.$client.unsafe(`CREATE FUNCTION retained_unsent_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.id = '${owner.receiptId}'::uuid THEN ${body} END IF; RETURN OLD; END $$;
        CREATE TRIGGER retained_unsent_delete_guard BEFORE DELETE ON plugin_tool_execution_receipts
        FOR EACH ROW EXECUTE FUNCTION retained_unsent_delete_guard()`);
      try {
        await expect(releaseRetainedWorkflowToolUnsent(db, owner, proof)).rejects.toThrow();
        expect(await step(s)).toEqual(beforeStep); expect(await receipt(owner)).toEqual(beforeReceipt);
      } finally { await db.$client.unsafe("DROP TRIGGER retained_unsent_delete_guard ON plugin_tool_execution_receipts; DROP FUNCTION retained_unsent_delete_guard()"); }
    }
  });

  it("lets a staged actual win when it owns the receipt after the workflow prefix", async () => {
    const s = await seed(), owner = await claim(s), { proof } = observe(owner), blocker = await reserve("workflow_runs", s.runId);
    let resolvePid!: (pid: number) => void; const started = new Promise<number>((resolve) => { resolvePid = resolve; });
    const release = releaseRetainedWorkflowToolUnsent(observedDb(db, resolvePid), owner, proof);
    const waiter = await started;
    try { await waitBlocked(waiter, blocker.pid); await stageRetainedToolOutcome(db, owner, actual); }
    finally { await blocker.release(); }
    expect((await release).kind).toBe("held");
    expect((await receipt(owner))?.resultBody).not.toBeNull(); expect((await step(s)).metadata.toolQueue).toMatchObject({ status: "claimed" });
  });

  it("does not acknowledge a staged actual that loses after release owns the receipt", async () => {
    const s = await seed(), owner = await claim(s), { proof } = observe(owner), gate = await db.$client.reserve();
    await gate.unsafe("begin"); await gate.unsafe("select pg_advisory_xact_lock(7600811)");
    await db.$client.unsafe(`CREATE FUNCTION retained_unsent_release_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.stepRunId}'::uuid THEN PERFORM pg_advisory_xact_lock(7600811); END IF; RETURN NEW; END $$;
      CREATE TRIGGER retained_unsent_release_barrier BEFORE UPDATE ON workflow_step_runs
      FOR EACH ROW EXECUTE FUNCTION retained_unsent_release_barrier()`);
    let resolveReleasePid!: (pid: number) => void, resolveStagePid!: (pid: number) => void;
    const releaseStarted = new Promise<number>((resolve) => { resolveReleasePid = resolve; });
    const stageStarted = new Promise<number>((resolve) => { resolveStagePid = resolve; });
    const releasing = releaseRetainedWorkflowToolUnsent(observedDb(db, resolveReleasePid), owner, proof);
    let acknowledged = false, failure: unknown;
    const attemptedActual = actual;
    let staging: Promise<void> | undefined;
    try {
      const rpid = await releaseStarted;
      const gatePid = (await gate.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }])[0]!.pid;
      await waitBlocked(rpid, gatePid);
      staging = stageRetainedToolOutcome(observedDb(db, resolveStagePid), owner, attemptedActual)
        .then(() => { acknowledged = true; }, (error) => { failure = error; });
      const spid = await stageStarted; await waitBlocked(spid, rpid);
      await gate.unsafe("rollback");
      expect((await releasing).kind).toBe("released"); await staging;
      expect(attemptedActual).toEqual(actual); expect(acknowledged).toBe(false);
      expect(failure).toBeInstanceOf(ToolReceiptPersistenceError); expect(failure).toMatchObject({ code: "missing" });
      expect(await receipt(owner)).toBeUndefined(); expect((await step(s)).metadata.toolQueue).toEqual({ status: "queued" });
    } finally {
      await gate.unsafe("rollback").catch(() => {}); gate.release();
      await Promise.allSettled([releasing, ...(staging ? [staging] : [])]);
      await db.$client.unsafe("DROP TRIGGER retained_unsent_release_barrier ON workflow_step_runs; DROP FUNCTION retained_unsent_release_barrier()");
    }
  });
});
