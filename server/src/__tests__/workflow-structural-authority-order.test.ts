import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, missions, workflowDefinitions, workflowRunDefinitions,
  workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun, insertStepRunForRun } from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";
import { captureExecutionDefinition, EXECUTION_DEFINITION_CREATION_MARKER_VERSION,
  loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { acceptWorkflowToolResult, type WorkflowToolResultAcceptanceHooks } from "../services/workflow/workflow-tool-result-acceptance.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";
import { writeStructuralCompletionInTransaction } from "../services/workflow/control-flow/structural-completion-write.js";
import { cancelWorkflowRunWithCleanup, type WorkflowExecutionContext, type WorkflowExecutionResult } from "../services/workflow/dag-engine.js";
import { finalizeWorkflowRunState } from "../services/workflow/workflow-run-finalization.js";
import { discoverLegacyStructuralScope, withWorkflowToolLockScope,
  type ExpectedWorkflowToolScope } from "../services/workflow/workflow-tool-lock-scope.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const gate = { id: "gate", name: "Gate", type: "tool", qaType: "structural", agentId: "",
  toolNames: ["validate"], dependencies: [], graphWorkProductRequired: false };
const token = { producerStepId: "producer", iterationIndex: 0, completedAt: "2026-10-29T00:00:00.000Z" };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = { companyId: string; missionId: string | null; runId: string; step: typeof workflowStepRuns.$inferSelect;
  requestId: string; expected: ExpectedWorkflowToolScope; kind: "plain" | "linked"; parentRunId?: string };
async function fixture(kind: "plain" | "linked" = "plain", withMission = true, stepOverrides: Record<string, unknown> = {}): Promise<Fixture> {
  const companyId = await createCompanyFixture(`s2-order-${randomUUID()}`);
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const mission = withMission
    ? (await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "Order", status: "active" }).returning())[0]!
    : null;
  const targetWorkflowId = await insertDefinition({ companyId, name: "Target", steps: [{ ...gate, ...stepOverrides }] });
  let runId: string, parentRunId: string | undefined;
  if (kind === "plain") {
    const run = await insertRunWithWorkflowStepRun({ companyId, workflowId: targetWorkflowId, stepId: gate.id, stepStatus: "running" });
    runId = run.runId;
    await db.update(workflowRuns).set({ missionId: mission?.id ?? null }).where(eq(workflowRuns.id, runId));
  } else {
    const parentWorkflowId = await insertDefinition({ companyId, name: "Parent", steps: [childStep(targetWorkflowId, { wait: true })] });
    parentRunId = randomUUID();
    await db.insert(workflowRuns).values({ id: parentRunId, companyId, workflowId: parentWorkflowId,
      missionId: mission?.id ?? null, status: "pending", triggeredBy: "board",
      metadata: { executionDefinitionVersion: EXECUTION_DEFINITION_CREATION_MARKER_VERSION } });
    const parentStepId = randomUUID();
    await db.insert(workflowStepRuns).values({ id: parentStepId, workflowRunId: parentRunId,
      stepId: "run-child", status: "pending" });
    await db.transaction(tx => captureExecutionDefinition(tx, parentRunId!));
    await db.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, parentRunId));
    const linked = await insertLinkedInvocation(db, { companyId, parentRunId, parentStepRunId: parentStepId,
      childWorkflowId: targetWorkflowId, stepId: "run-child", childStatus: "running" });
    runId = linked.childRunId;
    await insertStepRunForRun({ runId, stepId: gate.id, status: "running" });
    await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, runId));
  }
  const requestId = `request-${randomUUID()}`;
  const [step] = await db.update(workflowStepRuns).set({ lastDispatchRequestId: requestId,
    executionGeneration: 3, metadata: { structuralGateProducerToken: token } })
    .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, gate.id))).returning();
  const discovered = await discoverLegacyStructuralScope(db, { companyId, workflowRunId: runId });
  if (discovered.kind !== "ready") throw new Error(`fixture_discovery_failed:${discovered.reason}`);
  return { companyId, missionId: mission?.id ?? null, runId, step: step!, requestId,
    expected: discovered.expected, kind, parentRunId };
}

function completionInput(f: Fixture) {
  return { db, step: gate, success: true, data: { verdict: "pass" }, companyId: f.companyId,
    workflowRunId: f.runId, workflowStepRunId: f.step.id, missionId: f.missionId, issueId: null,
    requestId: f.requestId, source: "workflow_tool_result" as const, observedStatus: f.step.status,
    observedIterationIndex: f.step.iterationIndex, observedRequestId: f.step.lastDispatchRequestId,
    observedCompletedAt: f.step.completedAt, observedExecutionGeneration: f.step.executionGeneration,
    producerToken: token, patch: { startedAt: f.step.startedAt ?? new Date(), completedAt: new Date(),
      metadata: { ...f.step.metadata, result: "actual" }, fallbackFailureSummary: null } };
}

function pause() {
  let release!: () => void, enter!: (pid: number) => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<number>(resolve => { enter = resolve; });
  return { waiting, entered, release, enter };
}

function observeBackend(target: ReturnType<typeof createDb>, onPid: (pid: number) => void) {
  return new Proxy(target, { get(dbTarget, key, receiver) {
    if (key === "transaction") return (callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
      (dbTarget.transaction as unknown as (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>)(async tx => {
        const [{ pid }] = await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
        onPid(pid); return callback(tx);
      }, config);
    const value = Reflect.get(dbTarget, key, receiver);
    return typeof value === "function" ? value.bind(dbTarget) : value;
  } }) as ReturnType<typeof createDb>;
}

async function waitBlocked(waiter: number, blocker: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`select pg_blocking_pids(${waiter}::int) as blockers,
      (select query from pg_stat_activity where pid = ${waiter}::int) as query`) as unknown as Array<{ blockers: number[]; query: string }>;
    if (rows[0]?.blockers.includes(blocker)) return rows[0].query;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`backend ${waiter} was not observed blocked by ${blocker}`);
}

async function terminalHooks() {
  let snapshotCalls = 0, syncCalls = 0;
  const hooks: WorkflowToolResultAcceptanceHooks = {
    normalizeRecord: value => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
    getMetadataRecord: (value, key) => {
      const metadata = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const nested = metadata[key];
      return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
    },
    readMetadataString: value => typeof value === "string" ? value : undefined,
    buildWorkflowStepRunMetadata: (_step, metadata) => metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) } : {},
    getWorkflowExecutionResultSnapshot: async () => { snapshotCalls++; return null; },
    syncWorkflowRunState: async () => { syncCalls++; return null as unknown as WorkflowExecutionResult; },
  };
  return { hooks, counts: () => ({ snapshotCalls, syncCalls }) };
}

async function finalizeNative(f: Fixture, target = db) {
  const [run] = await target.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const stepRuns = await target.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId));
  const definition = await loadExecutionDefinition(target, f.runId, { requireHistorical: false });
  const context = { run, steps: definition.steps } as unknown as WorkflowExecutionContext;
  const hooks = {
    normalizeRecord: (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
    getDynamicLaunchStepIds: () => undefined,
    buildWorkflowDefinitionExecutionShape: () => ({ name: "test", executionMode: null, dynamicPlanBootstrapOnly: false, steps: [] }),
  } as Parameters<typeof finalizeWorkflowRunState>[5];
  return finalizeWorkflowRunState(target, context, stepRuns, false, false, hooks);
}

describePg("structural completion scope precedes legacy recovery and native writers", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-structural-authority-order-");
    db = createDb(temp.connectionString); configureWorkflowChildFixtures(db);
  }, 120_000);
  afterEach(async () => {
    for (const table of [workflowTransitionEvents, workflowStepInvocations, workflowRunDefinitions,
      workflowStepRuns, workflowRuns, workflowDefinitions, missions, agents, companies]) await db.delete(table);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("preserves successful failed-step recovery through the existing acceptance path", async () => {
    const f = await fixture("plain");
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, f.runId));
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date("2026-10-28T00:00:00.000Z") })
      .where(eq(workflowStepRuns.id, f.step.id));
    const observed = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id)))[0]!;
    const state = await terminalHooks();
    await acceptWorkflowToolResult(db, { companyId: f.companyId, stepRunId: f.step.id, workflowRunId: f.runId,
      requestId: f.requestId, success: true, data: { verdict: "pass" }, allowTerminalRecovery: true }, state.hooks);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, observed.id));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    expect(step).toMatchObject({ status: "completed", lastDispatchErrorAt: null });
    expect((step?.metadata as Record<string, unknown>).toolResult).toMatchObject({ recoveredBy: "owner-action", success: true });
    expect(run?.status).toBe("failed");
    expect(state.counts()).toEqual({ snapshotCalls: 0, syncCalls: 1 });
  });

  it("refuses a marker installed after discovery even when deleteAfterUse prepared metadata would remove it", async () => {
    const f = await fixture("plain", true, { executionControls: { deleteAfterUse: true } });
    const marker = { kind: "paperclip.retained-tool-completion", version: 1, receiptId: randomUUID() };
    const initial = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id)).then(rows => rows[0]!);
    let installed = false;
    const dbWithRacingMarker = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return async (callback: (tx: unknown) => Promise<unknown>, config?: unknown) => {
        if (!installed) {
          installed = true;
          await db.update(workflowStepRuns).set({ metadata: { ...initial.metadata,
            toolInvocation: { requestId: f.requestId, toolName: "validate", args: {}, retainedCompletion: marker } } })
            .where(eq(workflowStepRuns.id, f.step.id));
        }
        return db.transaction(callback as never, config as never);
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as ReturnType<typeof createDb>;
    const state = await terminalHooks();
    await acceptWorkflowToolResult(dbWithRacingMarker, { companyId: f.companyId, stepRunId: f.step.id,
      workflowRunId: f.runId, requestId: f.requestId, success: true, data: { verdict: "pass" }, toolName: "validate" }, state.hooks);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(step?.status).toBe("running");
    expect((step?.metadata as Record<string, unknown>).toolInvocation).toMatchObject({ retainedCompletion: marker });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id))).toHaveLength(0);
    expect(state.counts()).toEqual({ snapshotCalls: 1, syncCalls: 0 });
  });

  it("refuses malformed null markers during terminal recovery", async () => {
    const f = await fixture("plain");
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date(),
      metadata: { ...f.step.metadata, toolInvocation: { requestId: f.requestId, toolName: "validate", args: {}, retainedCompletion: null } } })
      .where(eq(workflowStepRuns.id, f.step.id));
    const state = await terminalHooks();
    await acceptWorkflowToolResult(db, { companyId: f.companyId, stepRunId: f.step.id, workflowRunId: f.runId,
      requestId: f.requestId, success: true, data: { verdict: "pass" }, allowTerminalRecovery: true }, state.hooks);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(step?.status).toBe("failed");
    expect((step?.metadata as Record<string, unknown>).toolInvocation).toMatchObject({ retainedCompletion: null });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id))).toHaveLength(0);
    expect(state.counts()).toEqual({ snapshotCalls: 1, syncCalls: 0 });
  });

  it("runs legacy linked completion when the child and parent step are terminal and parent mission is null", async () => {
    const f = await fixture("linked", false);
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, f.runId));
    if (f.parentRunId) await db.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, f.parentRunId));
    await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() })
      .where(and(eq(workflowStepRuns.workflowRunId, f.parentRunId!), eq(workflowStepRuns.stepId, "run-child")));
    const [failedStep] = await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date() })
      .where(eq(workflowStepRuns.id, f.step.id)).returning();
    const changed = await atomicStructuralCompletion(completionInput({ ...f, step: failedStep! }));
    expect(changed).toMatchObject({ casWon: true, effectiveSuccess: true });
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id)))[0]?.status).toBe("completed");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0]?.status).toBe("failed");
  });

  it("serializes plain structural completion before the native run finalizer", async () => {
    const f = await fixture("plain"), gate = pause();
    const holderPidPromise = gate.entered;
    const held = withWorkflowToolLockScope(db, f.expected, async scope => {
      const [{ pid }] = await scope.tx.execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
      gate.enter(pid); await gate.waiting;
      const { db: _db, ...writeInput } = completionInput(f);
      return writeStructuralCompletionInTransaction(scope, { ...writeInput, mode: "legacy" });
    });
    const holderPid = await holderPidPromise;
    let nativePid!: (pid: number) => void;
    const nativePidPromise = new Promise<number>(resolve => { nativePid = resolve; });
    const native = finalizeNative(f, observeBackend(db, nativePid));
    const waiter = await nativePidPromise;
    expect((await waitBlocked(waiter, holderPid)).toLowerCase()).toContain("workflow_runs");
    gate.release();
    await expect(held).resolves.toMatchObject({ casWon: true, effectiveSuccess: true });
    await expect(native).resolves.toMatchObject({ status: "running" });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id))).toHaveLength(2);
  });

  it("allows the plain native run lock to finish first before legacy structural completion enters", async () => {
    const f = await fixture("plain");
    await expect(finalizeNative(f)).resolves.toMatchObject({ status: "running" });
    await expect(atomicStructuralCompletion(completionInput(f))).resolves.toMatchObject({ casWon: true, effectiveSuccess: true });
  });

  it("serializes linked structural completion before the real direct child cancel writer", async () => {
    const f = await fixture("linked", false), gate = pause();
    const holderPidPromise = gate.entered;
    const held = withWorkflowToolLockScope(db, f.expected, async scope => {
      const [{ pid }] = await scope.tx.execute(sql`select pg_backend_pid() as pid`) as unknown as [{ pid: number }];
      gate.enter(pid); await gate.waiting;
      const { db: _db, ...writeInput } = completionInput(f);
      return writeStructuralCompletionInTransaction(scope, { ...writeInput, mode: "legacy" });
    });
    const holderPid = await holderPidPromise;
    let cancelEnter!: (pid: number) => void;
    const cancelPidPromise = new Promise<number>(resolve => { cancelEnter = resolve; });
    const cancel = cancelWorkflowRunWithCleanup(observeBackend(db, cancelEnter), f.runId, f.companyId);
    const cancelPid = await cancelPidPromise;
    expect((await waitBlocked(cancelPid, holderPid)).toLowerCase()).toContain("workflow_runs");
    gate.release();
    await expect(held).resolves.toMatchObject({ casWon: true });
    await expect(cancel).resolves.toBe(true);
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0]?.status).toBe("cancelled");
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id)))
      .toHaveLength(2);
  });

  it("allows real linked child cancellation to finish first before structural scope acquisition", async () => {
    const f = await fixture("linked", false);
    await expect(cancelWorkflowRunWithCleanup(db, f.runId, f.companyId)).resolves.toBe(true);
    const result = await atomicStructuralCompletion(completionInput(f));
    expect(typeof result.casWon).toBe("boolean");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId)))[0]?.status).toBe("cancelled");
  });
});
