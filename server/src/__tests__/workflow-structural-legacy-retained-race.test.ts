import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  agents, companies, createDb, pluginToolExecutionReceipts, workflowDefinitions, workflowRuns,
  workflowStepInvocations, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun, insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { insertInternalToolReceipt } from "../services/plugin-tool-execution-receipt.js";
import { requestForRow, validRequest, type RetainedToolRequest, type SpecializedToolAuthority } from "../services/plugin-tool-receipt-envelope.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";
import { writeStructuralCompletionInTransaction } from "../services/workflow/control-flow/structural-completion-write.js";
import { withSpecializedToolAuthority } from "../services/workflow/specialized-tool-authority.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const producer = { id: "producer", name: "Producer", type: "tool", toolNames: ["produce"], dependencies: [] };
const gate = { id: "gate", name: "Gate", type: "tool", qaType: "structural", toolNames: ["validate"],
  dependencies: ["producer"], graphWorkProductRequired: false };
const token = { producerStepId: "producer", iterationIndex: 2, completedAt: "2026-10-29T00:00:00.000Z" };
const acceptedAt = "2026-10-29T00:01:00.000Z";
const parameters = { input: "value" };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; kind: "plain" | "linked"; runId: string; step: typeof workflowStepRuns.$inferSelect;
  requestId: string; owner: RetainedToolRequest; marker: Record<string, unknown>;
};

function barrier() {
  let release!: () => void;
  let enter!: (pid: number) => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<number>((resolve) => { enter = resolve; });
  return { waiting, entered, release, pause: async (pid: number) => { enter(pid); await waiting; } };
}

async function fixture(kind: Fixture["kind"]): Promise<Fixture> {
  const companyId = await createCompanyFixture(`legacy-retained-${kind}-${randomUUID()}`);
  const targetWorkflowId = await insertDefinition({ companyId, name: "Structural target", steps: [producer, gate] });
  let runId: string;
  let linkedChild: SpecializedToolAuthority["linkedChild"] = null;
  if (kind === "plain") {
    const run = await insertRunWithWorkflowStepRun({ companyId, workflowId: targetWorkflowId,
      stepId: producer.id, stepStatus: "completed" });
    runId = run.runId;
    await insertStepRunForRun({ runId, stepId: gate.id, status: "running" });
  } else {
    const parentWorkflowId = await insertDefinition({ companyId, name: "Structural parent",
      steps: [childStep(targetWorkflowId)] });
    const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId,
      stepId: "run-child", stepStatus: "pending" });
    const linked = await insertMaterializedChildRun(db, { companyId, parentRunId: parent.runId,
      parentStepRunId: parent.stepRunId, childWorkflowId: targetWorkflowId, stepIds: [producer.id, gate.id] });
    runId = linked.childRunId;
    linkedChild = { identity: linked, targetWorkflowId, parentMissionId: null };
  }

  const requestId = `request-${randomUUID()}`;
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(token.completedAt) })
    .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, producer.id)));
  const [step] = await db.update(workflowStepRuns).set({ status: "running", iterationIndex: token.iterationIndex,
    executionGeneration: 4, lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt),
    metadata: { structuralGateProducerToken: token,
      toolQueue: { status: "claimed", claimedAt: acceptedAt },
      toolInvocation: { requestId, toolName: "validate", args: parameters } },
  }).where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, gate.id))).returning();

  const workflow = { missionId: null, workflowRunId: runId, stepRunId: step!.id, stepId: gate.id,
    requestId, executionGeneration: 4, statusTransitionVersion: step!.statusTransitionVersion,
    runStatus: "running" as const, stepStatus: "running" as const, acceptedAt,
    specialized: { structural: { producerToken: token, iterationIndex: token.iterationIndex, completedAt: null },
      linkedChild } };
  const owner = await insertInternalToolReceipt(db, { companyId, tool: "validate", parameters,
    consumer: "workflow", workflow });
  expect(validRequest(owner)).toBe(true);
  const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
  expect(requestForRow(receipt!)).toEqual(owner);

  const marker = { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
    tool: owner.tool, workflow: owner.workflow, claim: { status: "claimed", claimedAt: acceptedAt } };
  const priorMetadata = step!.metadata as Record<string, unknown>;
  const invocation = priorMetadata.toolInvocation as Record<string, unknown>;
  const [markedStep] = await db.update(workflowStepRuns).set({ metadata: {
    ...priorMetadata, toolInvocation: { ...invocation, retainedCompletion: marker },
  } }).where(eq(workflowStepRuns.id, step!.id)).returning();
  return { companyId, kind, runId, step: markedStep!, requestId, owner, marker };
}

function completionInput(f: Fixture, target: Db): Parameters<typeof atomicStructuralCompletion>[0] {
  return { db: target, step: gate, success: true, data: { verdict: "pass" }, companyId: f.companyId,
    workflowRunId: f.runId, workflowStepRunId: f.step.id, missionId: null, issueId: null,
    requestId: f.requestId, source: "workflow_tool_result", observedStatus: f.step.status,
    observedIterationIndex: f.step.iterationIndex, observedRequestId: f.step.lastDispatchRequestId,
    observedCompletedAt: f.step.completedAt, observedExecutionGeneration: f.step.executionGeneration,
    producerToken: token, patch: { startedAt: f.step.startedAt ?? new Date(), completedAt: new Date(),
      metadata: f.step.metadata, fallbackFailureSummary: null } };
}

function retainedAttemptWhere(f: Fixture) {
  return and(eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, gate.id),
    eq(workflowStepRuns.status, "running"), eq(workflowStepRuns.lastDispatchRequestId, f.requestId),
    eq(workflowStepRuns.executionGeneration, 4), eq(workflowStepRuns.statusTransitionVersion, f.step.statusTransitionVersion),
    eq(workflowStepRuns.lastDispatchAcceptedAt, new Date(acceptedAt)), isNull(workflowStepRuns.lastDispatchErrorAt),
    eq(workflowStepRuns.metadata, f.step.metadata),
    sql`${workflowStepRuns.metadata}->'toolInvocation'->'retainedCompletion' = ${JSON.stringify(f.marker)}::jsonb`)!;
}

async function retainedWrite(f: Fixture, target: Db, hold?: ReturnType<typeof barrier>) {
  return withSpecializedToolAuthority(target, f.owner, async (scope) => {
    const classified = await scope.classify();
    expect(classified.authority).toEqual({ kind: "current" });
    if (hold) {
      const [{ pid }] = await scope.tx.execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
      await hold.pause(pid);
    }
    const { db: _db, ...input } = completionInput(f, target);
    return writeStructuralCompletionInTransaction(scope, { ...input, mode: "retained",
      producerToken: token, attemptWhere: retainedAttemptWhere(f) });
  });
}

function pauseAfterScopeLock(tx: unknown, runId: string, hold: ReturnType<typeof barrier>, pid: number): unknown {
  let paused = false;
  const wrap = (builder: unknown, state: { table?: unknown; forUpdate: boolean }): unknown => {
    if (!builder || typeof builder !== "object") return builder;
    return new Proxy(builder, { get(target, key) {
      if (key === "then") {
        const then = Reflect.get(target, key, target);
        if (typeof then !== "function") return then;
        return (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          then.call(target, async (rows: unknown) => {
            if (!paused && state.table === workflowStepRuns && state.forUpdate && Array.isArray(rows) &&
                rows.some((row) => (row as { workflowRunId?: string }).workflowRunId === runId)) {
              paused = true;
              await hold.pause(pid);
            }
            return resolve(rows);
          }, reject);
      }
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const next = method.apply(target, args);
        return wrap(next, { table: key === "from" ? args[0] : state.table,
          forUpdate: key === "for" ? args[0] === "update" : state.forUpdate });
      };
    } });
  };
  return new Proxy(tx as object, { get(target, key) {
    const method = Reflect.get(target, key, target);
    if (key === "select" && typeof method === "function") {
      return (...args: unknown[]) => wrap(method.apply(target, args), { forUpdate: false });
    }
    return typeof method === "function" ? method.bind(target) : method;
  } });
}

function observeBackend(target: Db, onPid: (pid: number) => void,
  pause?: { runId: string; hold: ReturnType<typeof barrier> }): Db {
  return new Proxy(target, { get(dbTarget, key, receiver) {
    if (key === "transaction") return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      (dbTarget.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>)(async (tx) => {
        const [{ pid }] = await (tx as { execute: (query: unknown) => Promise<unknown> })
          .execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
        onPid(pid);
        const observed = pause ? pauseAfterScopeLock(tx, pause.runId, pause.hold, pid) : tx;
        return callback(observed);
      }, config);
    const value = Reflect.get(dbTarget, key, receiver);
    return typeof value === "function" ? value.bind(dbTarget) : value;
  } }) as Db;
}

async function waitBlocked(waiter: number, blocker: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`select pg_blocking_pids(${waiter}::int) as blockers,
      (select query from pg_stat_activity where pid = ${waiter}::int) as query`) as unknown as Array<{ blockers: number[]; query: string }>;
    if (rows[0]?.blockers.includes(blocker)) return rows[0].query;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${waiter} was not observed blocked by ${blocker}`);
}

async function expectOneAuthorizedWrite(f: Fixture, retained: Awaited<ReturnType<typeof retainedWrite>>,
  legacy: Awaited<ReturnType<typeof atomicStructuralCompletion>>) {
  expect(retained).toMatchObject({ casWon: true, effectiveSuccess: true, structuralGateRejected: false });
  expect(legacy).toMatchObject({ casWon: false, effectiveSuccess: true });
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
  expect(step?.status).toBe("completed");
  expect((step?.metadata as Record<string, unknown>).toolInvocation).toMatchObject({ retainedCompletion: f.marker });
  const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, f.owner.receiptId));
  expect(receipt).toMatchObject({ status: "executing", resultStatus: null, completedAt: null, workflowRunId: null, stepId: null });
  const ledger = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowStepRunId, f.step.id),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ verdict: "pass", decision: "pass",
    payload: { requestId: f.requestId, verdict: "pass", producerToken: token } });
  const transitions = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowStepRunId, f.step.id),
    eq(workflowTransitionEvents.eventType, "workflow_step_status_transition")));
  expect(transitions).toHaveLength(1);
  expect(transitions[0]).toMatchObject({ fromStatus: "running", toStatus: "completed" });
}

describePg("legacy and retained structural completion contend on the same run prefix", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-structural-legacy-retained-race-");
    db = createDb(temp.connectionString);
    configureWorkflowChildFixtures(db);
  }, 120_000);
  afterEach(async () => {
    for (const table of [workflowTransitionEvents, pluginToolExecutionReceipts, workflowStepInvocations,
      workflowStepRuns, workflowRuns, workflowDefinitions, agents, companies]) await db.delete(table);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it.each([
    { kind: "plain", first: "legacy" }, { kind: "plain", first: "retained" },
    { kind: "linked", first: "legacy" }, { kind: "linked", first: "retained" },
  ] as const)("serializes $kind when $first enters the shared prefix first", async ({ kind, first }) => {
    const f = await fixture(kind);
    const hold = barrier();
    let firstWork: Promise<unknown>;
    if (first === "retained") {
      firstWork = retainedWrite(f, db, hold);
    } else {
      const observedLegacy = observeBackend(db, () => undefined, { runId: f.runId, hold });
      firstWork = atomicStructuralCompletion(completionInput(f, observedLegacy));
    }
    const holder = await Promise.race([hold.entered,
      firstWork.then(() => { throw new Error("first entry finished before the prefix barrier"); })]);

    let waiterPid!: (pid: number) => void;
    const waiterPidPromise = new Promise<number>((resolve) => { waiterPid = resolve; });
    const observedWaiter = observeBackend(db, waiterPid);
    const secondWork = first === "retained"
      ? atomicStructuralCompletion(completionInput(f, observedWaiter))
      : retainedWrite(f, observedWaiter);
    const waiter = await Promise.race([waiterPidPromise,
      secondWork.then(() => { throw new Error("second entry finished before its transaction was observed"); })]);
    let blockedQuery = "";
    let observationError: unknown;
    try {
      blockedQuery = await waitBlocked(waiter, holder);
      expect(blockedQuery.toLowerCase()).toContain("workflow_runs");
      expect(blockedQuery.toLowerCase()).not.toContain("workflow_transition_events");
    } catch (error) {
      observationError = error;
    } finally {
      hold.release();
    }

    const [firstResult, secondResult] = await Promise.all([firstWork, secondWork]);
    if (observationError) throw observationError;
    const retained = first === "retained" ? firstResult : secondResult;
    const legacy = first === "legacy" ? firstResult : secondResult;
    await expectOneAuthorizedWrite(f, retained as Awaited<ReturnType<typeof retainedWrite>>,
      legacy as Awaited<ReturnType<typeof atomicStructuralCompletion>>);
  });
});
