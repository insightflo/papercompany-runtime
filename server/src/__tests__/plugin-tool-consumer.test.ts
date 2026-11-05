import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { pluginToolExecutionReceipts, workflowStepRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppWorkflowToolStepExecutor } from "../app.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginWorkerManager, type PluginWorkerHandle, type PluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { decodeRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import { requestForRow } from "../services/plugin-tool-receipt-envelope.js";
import { processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  startExecutionDefinitionFixture,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  type ExecutionDefinitionFixtureDb,
} from "./helpers/workflow-execution-definition-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const TOOL = "fixture.plugin:publish";
const PLUGIN_DB_ID = "fixture-plugin-worker";
const workerPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("consumer test barrier timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("consumer state did not reach expected value");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await nextTurn();
  expect(settled).toBe(false);
}

function waitForStream(streams: EventEmitter, predicate: (value: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const listener = (raw: unknown) => {
      const value = record(raw);
      if (predicate(value)) { streams.off("stream", listener); resolve(value); }
    };
    streams.on("stream", listener);
  });
}

function registerTool(dispatcher: ReturnType<typeof createPluginToolDispatcher>) {
  dispatcher.registerPluginTools("fixture.plugin", { tools: [{
    name: "publish", displayName: "Publish", description: "Publish", parametersSchema: { type: "object" },
  }] } as never, PLUGIN_DB_ID);
}

function startWorker(manager: PluginWorkerManager, onStreamNotification: NonNullable<WorkerStartOptions["onStreamNotification"]>) {
  return manager.startWorker(PLUGIN_DB_ID, {
    entrypointPath: workerPath, manifest: {} as never, config: {}, apiVersion: 1,
    autoRestart: false, rpcTimeoutMs: 60,
    instanceInfo: { instanceId: "consumer-test", hostVersion: "test" },
    hostHandlers: { "state.get": async () => ({}) }, onStreamNotification,
  });
}

describePostgres("plugin workflow tool consumer", () => {
  let fixture!: Extract<Awaited<ReturnType<typeof startExecutionDefinitionFixture>>, { supported: true }>;
  let db!: ExecutionDefinitionFixtureDb["db"];

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("plugin-tool-consumer-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = started.db;
  }, 120_000);

  afterAll(async () => { setWorkflowToolStepExecutor(null); await fixture?.cleanup(); });

  it("keeps a late result and worker held through DB acknowledgement while another mission progresses", async () => {
    const streams = new EventEmitter();
    const observed: Record<string, unknown>[] = [];
    let manager: PluginWorkerManager | undefined;
    let handle: PluginWorkerHandle | undefined;
    let stopping: Promise<void> | undefined;
    let releaseCommit!: () => void;
    let stageHeld!: () => void;
    let stageRejected!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const stageBarrier = new Promise<void>((resolve) => { stageHeld = resolve; });
    const rejectionBarrier = new Promise<void>((resolve) => { stageRejected = resolve; });
    let holdStageCommit = false;
    let rejectNextStage = false;

    const consumerDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return (callback: Parameters<typeof db.transaction>[0]) => {
          let rejectedStage = false;
          return target.transaction(async (tx) => {
            const result = await callback(tx);
            if (rejectNextStage) {
              rejectNextStage = false;
              rejectedStage = true;
              throw new Error("forced_stage_rejection");
            }
            if (holdStageCommit) {
              holdStageCommit = false;
              stageHeld();
              await commitGate;
            }
            return result;
          }).catch((error) => {
            if (rejectedStage) stageRejected();
            throw error;
          });
        };
      },
    }) as typeof db;

    async function seed(label: string) {
      const company = await seedCompanyWithMission(fixture.sql, `ptc${label}`);
      const stepId = "publish";
      const workflowId = await seedWorkflowDefinition(fixture.sql, {
        companyId: company.companyId,
        stepsJson: [{ id: stepId, name: "Publish", agentId: "", type: "tool", toolNames: [TOOL], dependencies: [] }],
      });
      const runId = await seedWorkflowRun(fixture.sql, {
        workflowId, companyId: company.companyId, missionId: company.missionId, status: "running", startedAt: new Date(),
      });
      const requestId = randomUUID();
      await db.insert(workflowStepRuns).values({
        workflowRunId: runId, stepId, status: "running", lastDispatchRequestId: requestId,
        metadata: { toolQueue: { status: "queued" }, toolInvocation: { requestId, toolName: TOOL, args: { label } } },
      });
      return runId;
    }

    const runIds = new Set([await seed("one"), await seed("two")]);
    try {
      manager = createPluginWorkerManager();
      handle = await startWorker(manager, (_method, value) => { observed.push(record(value)); streams.emit("stream", value); });
      const dispatcher = createPluginToolDispatcher({ workerManager: manager });
      registerTool(dispatcher);
      setWorkflowToolStepExecutor(createAppWorkflowToolStepExecutor({ db: consumerDb, toolDispatcher: dispatcher }));

      const firstDispatch = processQueuedWorkflowToolStepRuns(db, { limit: 1 });
      const firstEvent = await waitFor(waitForStream(streams, (value) => value.event === "tool-started"));
      const firstRunId = String(firstEvent.runId);
      expect(runIds.has(firstRunId)).toBe(true);
      expect(firstEvent.starts).toBe(1);
      expect(await waitFor(firstDispatch)).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
      expect(handle.diagnostics().pendingRequests).toBe(1);

      const secondDispatch = processQueuedWorkflowToolStepRuns(db, { limit: 1 });
      const secondEvent = await waitFor(waitForStream(streams,
        (value) => value.event === "tool-started" && value.runId !== firstRunId));
      const secondRunId = String(secondEvent.runId);
      expect(runIds.has(secondRunId)).toBe(true);
      expect(secondRunId).not.toBe(firstRunId);
      expect(secondEvent.starts).toBe(2);
      handle.notify("fixture.tool-release", { runId: secondRunId, result: { content: "second completed", data: { ok: true } } });
      expect(await waitFor(secondDispatch)).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
      await waitUntil(() => manager!.retainedJobCount() === 1);

      const [secondStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, secondRunId));
      expect(secondStep.status).toBe("completed");
      const secondReceiptId = String(record(record(secondStep.metadata.toolInvocation).retainedCompletion).receiptId);
      const [secondReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, secondReceiptId));
      expect(secondReceipt.status).toBe("completed");

      const noReplay = await processQueuedWorkflowToolStepRuns(db, { limit: 10 });
      expect(noReplay.claimedCount).toBe(0);
      expect(observed.filter((event) => event.event === "tool-started")).toHaveLength(2);
      const [firstStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, firstRunId));
      const firstReceiptId = String(record(record(firstStep.metadata.toolInvocation).retainedCompletion).receiptId);
      const [beforeLate] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, firstReceiptId));
      expect(firstStep.status).toBe("running");
      expect(beforeLate).toMatchObject({ status: "executing", resultBody: null, resultStatus: null });

      rejectNextStage = true;
      holdStageCommit = true;
      handle.notify("fixture.tool-release", { runId: firstRunId, result: { content: "late completion", data: { ok: true, seq: 1 } } });
      await waitFor(rejectionBarrier);
      stopping = manager.stopAll();
      await expectPending(stopping);
      await waitFor(stageBarrier);
      const [uncommitted] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, firstReceiptId));
      const [uncommittedStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, firstRunId));
      expect(uncommitted).toMatchObject({ status: "executing", resultBody: null, resultStatus: null });
      expect(uncommittedStep).toEqual(firstStep);
      expect(manager.retainedJobCount()).toBe(1);
      await expectPending(stopping);
      releaseCommit();
      await waitFor(stopping);

      const [firstAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, firstRunId));
      const [firstReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, firstReceiptId));
      expect(requestForRow(firstReceipt)).toEqual(requestForRow(beforeLate));
      expect(firstAfter.status).toBe("completed");
      expect(firstReceipt.status).toBe("completed");
      expect(decodeRetainedToolOutcome(firstReceipt.resultBody)?.actual).toMatchObject({
        kind: "result", result: { content: "late completion", data: { ok: true, seq: 1 } },
        response: { jsonrpc: "2.0", result: { content: "late completion", data: { ok: true, seq: 1 } } },
      });
      expect(typeof record(record(decodeRetainedToolOutcome(firstReceipt.resultBody)?.actual).response).id).toBe("number");
      expect(await processQueuedWorkflowToolStepRuns(db, { limit: 10 })).toMatchObject({ claimedCount: 0 });
      expect(observed.filter((event) => event.event === "tool-started")).toHaveLength(2);
    } finally {
      releaseCommit();
      if (manager && !stopping) {
        if (handle?.status === "running" && manager.retainedJobCount() > 0) handle.notify("fixture.crash", {});
        void manager.stopAll();
      }
      setWorkflowToolStepExecutor(null);
    }
  }, 120_000);

  it("releases a real missing-worker observation and lets the existing queue replay once", async () => {
    const streams = new EventEmitter();
    const observed: Record<string, unknown>[] = [];
    let manager: PluginWorkerManager | undefined;
    let handle: PluginWorkerHandle | undefined;
    const company = await seedCompanyWithMission(fixture.sql, "ptc-unsent");
    const stepId = "publish";
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: company.companyId,
      stepsJson: [{ id: stepId, name: "Publish", agentId: "", type: "tool", toolNames: [TOOL], dependencies: [] }],
    });
    const runId = await seedWorkflowRun(fixture.sql, {
      workflowId, companyId: company.companyId, missionId: company.missionId, status: "running", startedAt: new Date(),
    });
    const requestId = randomUUID();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "running", lastDispatchRequestId: requestId,
      metadata: { toolQueue: { status: "queued" }, toolInvocation: { requestId, toolName: TOOL, args: { label: "unsent" } } },
    });
    try {
      manager = createPluginWorkerManager();
      const dispatcher = createPluginToolDispatcher({ workerManager: manager });
      registerTool(dispatcher);
      setWorkflowToolStepExecutor(createAppWorkflowToolStepExecutor({ db, toolDispatcher: dispatcher }));

      const unsent = await processQueuedWorkflowToolStepRuns(db, { limit: 1 });
      expect(unsent).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 0, skippedCount: 1 });
      expect(observed).toHaveLength(0);
      const [queued] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      expect(queued).toMatchObject({ status: "running", lastDispatchAcceptedAt: null });
      expect(record(queued.metadata.toolQueue).status).toBe("queued");
      expect(record(queued.metadata.toolInvocation)).not.toHaveProperty("retainedCompletion");
      expect(await db.select().from(pluginToolExecutionReceipts)
        .where(eq(pluginToolExecutionReceipts.workflowRunId, runId))).toHaveLength(0);

      handle = await startWorker(manager, (_method, value) => { observed.push(record(value)); streams.emit("stream", value); });
      const replay = processQueuedWorkflowToolStepRuns(db, { limit: 1 });
      const started = await waitFor(waitForStream(streams, (value) => value.event === "tool-started"));
      expect(started).toMatchObject({ runId, starts: 1 });
      handle.notify("fixture.tool-release", { runId, result: { content: "replayed once", data: { ok: true } } });
      expect(await waitFor(replay)).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
      await waitUntil(() => manager!.retainedJobCount() === 0);
      const [completed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const receipts = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.workflowRunId, runId));
      expect(completed.status).toBe("completed");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.status).toBe("completed");
      expect(decodeRetainedToolOutcome(receipts[0]!.resultBody)?.actual).toMatchObject({
        kind: "result", result: { content: "replayed once", data: { ok: true } },
      });
      expect(observed.filter((event) => event.event === "tool-started")).toHaveLength(1);
    } finally {
      if (manager && manager.retainedJobCount() === 0) await manager.stopAll();
      else if (manager && handle?.status === "running") {
        handle.notify("fixture.crash", {});
        void manager.stopAll();
      }
      setWorkflowToolStepExecutor(null);
    }
  }, 120_000);
});
