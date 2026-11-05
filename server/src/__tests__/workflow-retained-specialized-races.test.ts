// @vitest-environment node
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, missions, pluginToolExecutionReceipts, workflowDefinitions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTerminalDecisions,
  workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun } from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { decodeRetainedToolOutcome, stageRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import { bindRetainedWorkflowTool, finalizeRetainedWorkflowTool } from "../services/workflow/retained-tool-completion.js";
import { cancelWorkflowRunWithCleanup, syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const support = await getEmbeddedPostgresTestSupport(), describePg = support.supported ? describe : describe.skip;
const token = { producerStepId: "producer", iterationIndex: 0, completedAt: "2026-10-28T12:00:00.000Z" };
const acceptedAt = "2026-10-29T00:00:00.000Z", parameters = { query: "race" };
const pass: ToolOutcome = { kind: "result", result: { content: "pass", data: { verdict: "pass" } },
  response: { jsonrpc: "2.0", id: 9, result: { content: "pass", data: { verdict: "pass" } } } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
type StepRun = typeof workflowStepRuns.$inferSelect;
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

function hooks(sync = syncWorkflowRunStateWithOutcome) {
  return { normalizeRecord: record, getMetadataRecord: (value: unknown, key: string) => record(record(value)[key]),
    readMetadataString: (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined,
    buildWorkflowStepRunMetadata: (step: { executionControls?: unknown; graphWorkProductRequired?: boolean }, metadata: unknown) => ({
      ...record(metadata), ...(step.executionControls ? { executionControls: step.executionControls } : {}),
      graphWorkProductRequired: step.graphWorkProductRequired === true,
    }), syncWorkflowRunStateWithOutcome: sync };
}

async function fixture() {
  const companyId = await createCompanyFixture(`s3-race-${randomUUID()}`);
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "S3 race", status: "active" }).returning();
  const targetWorkflowId = await insertDefinition({ companyId, name: "Target", steps: [
    { id: "producer", name: "Producer", type: "tool", toolNames: ["plugin:producer"], dependencies: [] },
    { id: "gate", name: "Gate", type: "tool", qaType: "structural", toolNames: ["plugin:gate"], dependencies: ["producer"] },
  ] });
  const parentWorkflowId = await insertDefinition({ companyId, name: "Parent", steps: [childStep(targetWorkflowId)] });
  const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId, stepId: "run-child", stepStatus: "pending" });
  await db.update(workflowRuns).set({ missionId: mission!.id }).where(eq(workflowRuns.id, parent.runId));
  const child = await insertMaterializedChildRun(db, { companyId, parentRunId: parent.runId,
    parentStepRunId: parent.stepRunId, childWorkflowId: targetWorkflowId, stepIds: ["producer", "gate"] });
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, child.childRunId));
  const producer = rows.find((row) => row.stepId === "producer")!, gate = rows.find((row) => row.stepId === "gate")!;
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(token.completedAt) }).where(eq(workflowStepRuns.id, producer.id));
  const requestId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", iterationIndex: 2, executionGeneration: 4,
    lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt), metadata: {
      structuralGateProducerToken: token, toolQueue: { status: "claimed", claimedAt: acceptedAt },
      toolInvocation: { requestId, toolName: "plugin:gate", args: parameters },
    } }).where(eq(workflowStepRuns.id, gate.id));
  const [current] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate.id));
  const scope = { companyId, tool: "plugin:gate", parameters, workflow: { missionId: null, workflowRunId: child.childRunId,
    stepRunId: gate.id, stepId: "gate", requestId, executionGeneration: 4,
    statusTransitionVersion: current!.statusTransitionVersion, runStatus: "running" as const,
    stepStatus: "running" as const, acceptedAt } };
  const bound = await bindRetainedWorkflowTool(db, scope);
  if (bound.kind !== "claim") throw new Error(`expected one retained claim, got ${bound.kind}`);
  return { companyId, missionId: mission!.id, parentRunId: parent.runId, parentWorkflowId, parentStepRunId: child.parentStepRunId,
    invocationId: child.invocationId, childRunId: child.childRunId, gateStepId: gate.id, owner: bound.owner };
}

async function expectUnchangedAttempt(f: Awaited<ReturnType<typeof fixture>>, before: StepRun,
  receiptStatus: "executing" | "completed" = "executing", disposition?: "superseded") {
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
  const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId));
  const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
  const outcome = decodeRetainedToolOutcome(receipt!.resultBody);
  expect(step).toEqual(before); expect(events).toEqual([]); expect(receipt!.status).toBe(receiptStatus);
  expect(outcome?.actual).toEqual(pass); expect(outcome?.disposition?.kind).toBe(disposition);
}

async function waitBlocked(waiter: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`select pg_blocking_pids(${waiter}::int) as blockers`) as unknown as Array<{ blockers: number[] }>;
    if (rows[0]?.blockers.includes(blocker)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${waiter} was not observed blocked by ${blocker}`);
}

async function createReplacement(companyId: string, runId: string) {
  const [source] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  const [decision] = await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: runId,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "test", discoveryPath: "test", origin: "test" }).returning();
  const [approval] = await db.insert(approvals).values({ companyId, type: "replacement", status: "approved", payload: {} }).returning();
  const [replacementRun] = await db.insert(workflowRuns).values({ companyId, workflowId: source!.workflowId,
    missionId: null, triggeredBy: "test" }).returning();
  const [event] = await db.insert(workflowTransitionEvents).values({ companyId, eventType: "replacement", layer: "test" }).returning();
  await db.insert(workflowRecoveryAuthorities).values({ companyId, workflowRunId: runId, targetAuthorityVersion: 0,
    resultingAuthorityVersion: 0, targetDecisionId: decision!.id, recoveryKind: "replacement_from_start_v1",
    requestedBy: "test", requestReference: randomUUID(), ownerDecisionEventId: event!.id,
    operatorApprovalId: approval!.id, replacementRunId: replacementRun!.id, requestHash: "a".repeat(64), replacementContract: {} });
  return replacementRun!;
}

function observeTransaction(target: Db, onPid: (pid: number) => void, captureAt = 1): Db {
  let transaction = 0;
  return new Proxy(target, { get(dbTarget, key, receiver) {
    if (key !== "transaction") return Reflect.get(dbTarget, key, receiver);
    return (callback: (tx: unknown) => Promise<unknown>, ...args: unknown[]) =>
      (dbTarget.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>)(async (tx) => {
        transaction += 1;
        if (transaction === captureAt) {
          const rows = await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
          onPid(rows[0]!.pid);
        }
        return callback(tx);
      }, ...args);
  } }) as Db;
}

describePg("retained specialized workflow deterministic races", () => {
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("retained-specialized-races-");
    db = createDb(temp.connectionString); configureWorkflowChildFixtures(db); }, 120_000);
  afterEach(async () => { for (const table of [workflowRecoveryAuthorities, workflowTerminalDecisions, approvals, workflowTransitionEvents,
    activityLog, pluginToolExecutionReceipts, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, missions, agents, companies]) {
    await db.delete(table);
  } });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("stages before locks, then supersedes a child canceled at the prelude barrier", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void, transactions = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const observed = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (callback: (tx: unknown) => Promise<unknown>, ...args: unknown[]) => {
        const index = ++transactions;
        return (target.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>)(async (tx) => {
          if (index === 2) { entered(); await gate; } return callback(tx);
        }, ...args);
      };
    } }) as Db;
    const completion = finalizeRetainedWorkflowTool(observed, f.owner, pass, hooks());
    try {
      await ready;
      expect(await cancelWorkflowRunWithCleanup(db, f.childRunId, f.companyId)).toBe(true);
      const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      const ledgerBefore = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
      release();
      await expect(completion).resolves.toMatchObject({ kind: "superseded" });
      const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId));
      expect(after).toEqual(before); expect(await db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId))).toEqual(ledgerBefore);
      expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "superseded" } });
    } finally { release(); await Promise.allSettled([completion]); }
  });

  it("commits retained completion before a waiting cancel and does not resurrect the canceled child", async () => {
    const f = await fixture(); let releaseFinalizer!: () => void, finalizerLocked!: () => void, transactions = 0;
    const gate = new Promise<void>((resolve) => { releaseFinalizer = resolve; }), ready = new Promise<void>((resolve) => { finalizerLocked = resolve; });
    let finalizerPid = 0, cancelPid = 0, cancelDone!: () => void;
    const canceled = new Promise<void>((resolve) => { cancelDone = resolve; });
    const finalizerDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (callback: (tx: unknown) => Promise<unknown>, ...args: unknown[]) => {
        const index = ++transactions;
        return (target.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>)(async (tx) => {
          if (index !== 2) return callback(tx);
          const rows = await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
          finalizerPid = rows[0]!.pid;
          const result = await callback(tx); finalizerLocked(); await gate; return result;
        }, ...args);
      };
    } }) as Db;
    const cancelDb = observeTransaction(db, (pid) => { if (!cancelPid) cancelPid = pid; });
    const h = hooks(async (...args) => { await canceled; return syncWorkflowRunStateWithOutcome(...args); });
    let completion: ReturnType<typeof finalizeRetainedWorkflowTool> | undefined, cancellation: Promise<boolean> | undefined;
    try {
      completion = finalizeRetainedWorkflowTool(finalizerDb, f.owner, pass, h);
      await ready;
      cancellation = cancelWorkflowRunWithCleanup(cancelDb, f.childRunId, f.companyId);
      const deadline = Date.now() + 5_000;
      while (!cancelPid && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
      if (!cancelPid) throw new Error("cancellation transaction did not start");
      await waitBlocked(cancelPid, finalizerPid);
      releaseFinalizer();
      expect(await cancellation).toBe(true); cancelDone();
      const result = await Promise.allSettled([completion]);
      const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.childRunId));
      const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId));
      expect(child!.status).toBe("cancelled");
      expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "applied" } });
      if (result[0]!.status === "fulfilled") expect(result[0]!.value).toMatchObject({ kind: "applied" });
      else expect(result[0]!.reason).toMatchObject({ reason: "sync_not-owner" });
    } finally {
      releaseFinalizer(); cancelDone(); await Promise.allSettled([...(completion ? [completion] : []), ...(cancellation ? [cancellation] : [])]);
    }
  });

  it("rolls back ledger, step and receipt together when receipt completion fails", async () => {
    const f = await fixture();
    const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
    await db.$client.unsafe(`CREATE FUNCTION specialized_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${f.owner.receiptId}'::uuid AND NEW.status = 'completed' THEN RAISE EXCEPTION 'receipt completion failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER specialized_reject_receipt BEFORE UPDATE ON plugin_tool_execution_receipts
      FOR EACH ROW EXECUTE FUNCTION specialized_reject_receipt()`);
    try {
      await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).rejects.toThrow("receipt completion failure");
      await expectUnchangedAttempt(f, before!);
    } finally {
      await db.$client.unsafe("DROP TRIGGER specialized_reject_receipt ON plugin_tool_execution_receipts; DROP FUNCTION specialized_reject_receipt()");
    }
    await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).resolves.toMatchObject({ kind: "applied" });
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
    const verdicts = events.filter((event) => event.eventType === "workflow_validation_verdict");
    const transitions = events.filter((event) => event.eventType === "workflow_step_status_transition");
    expect(verdicts).toHaveLength(1); expect(verdicts[0]!.payload).toMatchObject({ producerToken: token });
    expect(transitions).toHaveLength(1); expect(transitions[0]).toMatchObject({ fromStatus: "running", toStatus: "completed",
      payload: { transitionVersion: f.owner.workflow!.statusTransitionVersion + 1 } });
    expect(decodeRetainedToolOutcome((await db.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId)))[0]!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "applied" } });
    await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).resolves.toMatchObject({ kind: "applied" });
    const replayedEvents = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
    expect(replayedEvents.filter((event) => event.eventType === "workflow_validation_verdict")).toHaveLength(1);
    expect(replayedEvents.filter((event) => event.eventType === "workflow_step_status_transition")).toHaveLength(1);
  });

  it("rolls back when the database reports an unexpected transition version", async () => {
    const f = await fixture(); await stageRetainedToolOutcome(db, f.owner, pass);
    const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
    await db.$client.unsafe(`CREATE FUNCTION specialized_wrong_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${f.gateStepId}'::uuid THEN NEW.status_transition_version := OLD.status_transition_version + 2; END IF;
      RETURN NEW; END $$; CREATE TRIGGER zzz_specialized_wrong_version BEFORE UPDATE OF status ON workflow_step_runs
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION specialized_wrong_version()`);
    try {
      await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).rejects
        .toMatchObject({ reason: "completion_postcondition_failed" });
      await expectUnchangedAttempt(f, before!);
    } finally {
      await db.$client.unsafe("DROP TRIGGER zzz_specialized_wrong_version ON workflow_step_runs; DROP FUNCTION specialized_wrong_version()");
    }
  });

  it.each(["request", "generation", "version", "accepted"] as const)
    ("does not apply staged actual after linked %s authority changes", async (change) => {
      const f = await fixture(); await stageRetainedToolOutcome(db, f.owner, pass);
      if (change === "request") await db.update(workflowStepRuns).set({ lastDispatchRequestId: randomUUID() }).where(eq(workflowStepRuns.id, f.gateStepId));
      if (change === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 5 }).where(eq(workflowStepRuns.id, f.gateStepId));
      if (change === "version") await db.update(workflowStepRuns).set({ statusTransitionVersion: f.owner.workflow!.statusTransitionVersion + 1 })
        .where(eq(workflowStepRuns.id, f.gateStepId));
      if (change === "accepted") await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: new Date("2026-10-30T00:00:00.000Z") })
        .where(eq(workflowStepRuns.id, f.gateStepId));
      const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).resolves.toMatchObject({ kind: "superseded" });
      await expectUnchangedAttempt(f, before!, "completed", "superseded");
    });

  it.each(["generation", "target"] as const)("rejects immutable linked invocation %s mutation and keeps staged actual", async (change) => {
    const f = await fixture(); await stageRetainedToolOutcome(db, f.owner, pass);
    const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, f.invocationId));
    const mutation = change === "generation"
      ? db.update(workflowStepInvocations).set({ generation: 2 }).where(eq(workflowStepInvocations.id, f.invocationId))
      : db.update(workflowStepInvocations).set({ targetWorkflowId: await insertDefinition({ companyId: f.companyId, name: "Other target", steps: [] }) })
        .where(eq(workflowStepInvocations.id, f.invocationId));
    await expect(mutation).rejects.toMatchObject(change === "generation"
      ? { code: "23514", constraint_name: "workflow_step_invocations_generation_one_ck" } : { code: "23514" });
    if (change === "target") await expect(mutation).rejects.toThrow("workflow_child_target_identity_immutable");
    expect(await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, f.invocationId))).toEqual([invocation]);
    await expectUnchangedAttempt(f, before!);
  });

  it("holds staged actual when an uncaptured legacy parent definition target drifts", async () => {
    const f = await fixture(); await stageRetainedToolOutcome(db, f.owner, pass);
    expect((await loadExecutionDefinition(db, f.parentRunId, { requireHistorical: false })).source).toBe("legacy_current");
    const target = await insertDefinition({ companyId: f.companyId, name: "Drifted target", steps: [] });
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(target)] }).where(eq(workflowDefinitions.id, f.parentWorkflowId));
    const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
    await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).rejects
      .toMatchObject({ reason: "parent_target_capture_inconsistent" });
    await expectUnchangedAttempt(f, before!);
  });

  it.each(["parent", "child"] as const)("supersedes without following a %s replacement authority", async (which) => {
    const f = await fixture(); await stageRetainedToolOutcome(db, f.owner, pass);
    const replacement = await createReplacement(f.companyId, which === "parent" ? f.parentRunId : f.childRunId);
    const [replacementBefore] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, replacement.id));
    await expect(finalizeRetainedWorkflowTool(db, f.owner, pass, hooks())).resolves.toMatchObject({ kind: "superseded" });
    const [replacementAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, replacement.id));
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId));
    expect(replacementAfter).toEqual(replacementBefore);
    expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "superseded" } });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId)))
      .toHaveLength(0);
  });
});
