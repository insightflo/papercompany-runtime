// @vitest-environment node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { companies, createDb, pluginToolExecutionReceipts, workflowDefinitions, workflowRuns,
  workflowStepInvocations, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { observePluginTool, type ObservedToolExecution } from "../services/plugin-tool-observation.js";
import { TOOL_NAMESPACE_SEPARATOR, type RegisteredTool } from "../services/plugin-tool-registry.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import { decodeRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import type { RetainedToolRequest } from "../services/plugin-tool-receipt-envelope.js";
import { bindRetainedWorkflowTool, finalizeRetainedWorkflowTool, processQueuedWorkflowToolStepRuns,
  releaseRetainedWorkflowToolUnsent, setWorkflowToolStepExecutor, type WorkflowToolStepExecutionRequest } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const TOOL = "fixture.plugin:publish", PLUGIN_ID = "fixture.plugin", PLUGIN_DB_ID = "fixture-plugin-worker";
const workerPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
const manifest: PaperclipPluginManifestV1 = { id: PLUGIN_ID, apiVersion: 1, version: "1.0.0",
  displayName: "Fixture", description: "Queue replay fixture", author: "Paperclip", categories: ["connector"],
  capabilities: [], entrypoints: { worker: workerPath } };
const registeredTool: RegisteredTool = { pluginId: PLUGIN_ID, pluginDbId: PLUGIN_DB_ID, name: "publish",
  namespacedName: TOOL, displayName: "Publish", description: "Replay fixture", parametersSchema: { type: "object" } };
type PositiveUnsent = Extract<ObservedToolExecution, { kind: "definitely_unsent" | "deferred_before_start" }>;
type SeededRun = { runId: string; stepRunId: string; requestId: string };
type HeldResultCase = { run: SeededRun; shape: "valid-held" | "malformed" | "mismatched" | "contradictory" };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let manager: PluginWorkerManager | undefined;

async function seedRun(companyId: string, workflowId: string, order: number): Promise<SeededRun> {
  const runId = randomUUID(), stepRunId = randomUUID(), requestId = randomUUID();
  await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, status: "running", triggeredBy: "test" });
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId: "publish", status: "running",
    startedAt: new Date(Date.now() + order * 1000), lastDispatchRequestId: requestId,
    metadata: { toolQueue: { status: "queued" }, toolInvocation: { requestId, toolName: TOOL, args: { order } } } });
  return { runId, stepRunId, requestId };
}

function observe(request: WorkflowToolStepExecutionRequest, lifecycle = createRuntimeExecutionLifecycle()): ObservedToolExecution {
  const authority = request.originalAuthority;
  if (!authority) throw new Error("workflow queue did not capture original authority");
  const runContext: ToolRunContext = { agentId: request.agentId ?? randomUUID(), runId: request.workflowRunId,
    companyId: request.companyId, projectId: "" };
  return observePluginTool({ namespacedName: request.toolName,
    parseName: (name) => { const separator = name.lastIndexOf(TOOL_NAMESPACE_SEPARATOR);
      return separator > 0 ? { pluginId: name.slice(0, separator), toolName: name.slice(separator + 1) } : null; },
    byNamespace: new Map([[TOOL, registeredTool]]), workerManager: manager,
    parameters: request.args, runContext, identity: { requestId: authority.requestId,
      executionId: authority.workflowRunId, attemptId: authority.stepRunId,
      executionGeneration: authority.executionGeneration }, runtimeLifecycle: lifecycle });
}

async function readStep(stepRunId: string) {
  const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  if (!row) throw new Error(`workflow step run missing: ${stepRunId}`);
  return row;
}

describePg("retained workflow positive-unsent queue replay", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("retained-unsent-replay-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await manager?.stopAll(); manager = undefined;
    if (!db) return;
    await db.delete(pluginToolExecutionReceipts); await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepInvocations); await db.delete(workflowStepRuns);
    await db.delete(workflowRuns); await db.delete(workflowDefinitions); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("releases only a routed no-send owner, replays once, and preserves legacy deferral progress", async () => {
    const companyId = randomUUID(), workflowId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retained Replay" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Retained Replay",
      stepsJson: [{ id: "publish", name: "Publish", type: "tool", toolNames: [TOOL], toolArgs: {}, dependencies: [] }] });
    const retained = await seedRun(companyId, workflowId, 0), legacy = await seedRun(companyId, workflowId, 1),
      progress = await seedRun(companyId, workflowId, 2);
    const heldCases: HeldResultCase[] = [
      { run: await seedRun(companyId, workflowId, 3), shape: "valid-held" },
      { run: await seedRun(companyId, workflowId, 4), shape: "malformed" },
      { run: await seedRun(companyId, workflowId, 5), shape: "mismatched" },
      { run: await seedRun(companyId, workflowId, 6), shape: "contradictory" },
    ];
    const workerManager = createPluginWorkerManager();
    manager = workerManager;
    let oldOwner: RetainedToolRequest | undefined, oldProof: PositiveUnsent | undefined;
    let replayOwner: RetainedToolRequest | undefined, replayConsumer: Promise<void> | undefined,
      retainedCalls = 0;
    const heldReceiptIds = new Map<string, string>();
    const heldSnapshots: Array<{ step: Awaited<ReturnType<typeof readStep>>;
      events: typeof workflowTransitionEvents.$inferSelect[] }> = [];
    const toolStarts: Record<string, unknown>[] = [];
    let resolveStarted: ((event: Record<string, unknown>) => void) | undefined;
    const started = new Promise<Record<string, unknown>>((resolve) => { resolveStarted = resolve; });
    setWorkflowToolStepExecutor(async (request) => {
      if (request.workflowRunId === retained.runId) {
        retainedCalls += 1;
        const authority = request.originalAuthority;
        if (!authority) throw new Error("workflow queue did not capture original authority");
        const bound = await bindRetainedWorkflowTool(db, { companyId: request.companyId, tool: request.toolName,
          parameters: request.args ?? {}, workflow: authority });
        if (bound.kind !== "claim") throw new Error(`retained bind did not claim: ${bound.kind}`);
        const routed = observe(request);
        if (retainedCalls === 1) {
          if (routed.kind !== "definitely_unsent") throw new Error(`expected missing-worker no-send, got ${routed.kind}`);
          oldOwner = bound.owner; oldProof = routed;
          const released = await releaseRetainedWorkflowToolUnsent(db, bound.owner, routed);
          return { accepted: true, retainedUnsentRelease: released };
        }
        if (routed.kind !== "sent_or_unknown") throw new Error(`expected real worker send, got ${routed.kind}`);
        replayOwner = bound.owner;
        replayConsumer = routed.observation.actual.then(async (actual) => {
          const disposition = await finalizeRetainedWorkflowTool(db, bound.owner, actual);
          expect(disposition.kind).toBe("applied");
          expect(routed.observation.acknowledge()).toBe(true);
        });
        await routed.observation.initial;
        return { accepted: true };
      }
      if (request.workflowRunId === legacy.runId) {
        const lifecycle = createRuntimeExecutionLifecycle(); lifecycle.beginShutdown("SIGTERM");
        const routed = observe(request, lifecycle);
        if (routed.kind !== "deferred_before_start") throw new Error(`expected routed legacy deferral, got ${routed.kind}`);
        return { deferredBeforeStart: routed.deferredBeforeStart };
      }
      if (request.workflowRunId === progress.runId) return { accepted: true };
      const heldCase = heldCases.find((candidate) => candidate.run.runId === request.workflowRunId);
      if (heldCase) {
        const authority = request.originalAuthority;
        if (!authority) throw new Error("workflow queue did not capture held-row authority");
        const bound = await bindRetainedWorkflowTool(db, { companyId: request.companyId, tool: request.toolName,
          parameters: request.args ?? {}, workflow: authority });
        if (bound.kind !== "claim") throw new Error(`held-row bind did not claim: ${bound.kind}`);
        const beforeStep = await readStep(request.stepRunId);
        const beforeEvents = await db.select().from(workflowTransitionEvents)
          .where(eq(workflowTransitionEvents.workflowStepRunId, request.stepRunId));
        const routed = observe(request);
        if (routed.kind !== "definitely_unsent") throw new Error(`expected a real no-send observation, got ${routed.kind}`);
        const mismatchedProof = { ...routed, identity: { ...routed.identity, requestId: randomUUID() } };
        const held = await releaseRetainedWorkflowToolUnsent(db, bound.owner, mismatchedProof);
        if (held.kind !== "held" || !held.workflow || !held.receiptId) throw new Error("mismatched proof was not held");
        heldReceiptIds.set(request.workflowRunId, held.receiptId);
        heldSnapshots.push({ step: beforeStep, events: beforeEvents });
        if (heldCase.shape === "malformed") return { accepted: true,
          retainedUnsentRelease: Object.assign({}, held, { unexpectedField: true }) };
        if (heldCase.shape === "mismatched") return { accepted: true, retainedUnsentRelease: { ...held,
          workflow: { ...held.workflow, executionGeneration: held.workflow.executionGeneration + 1 } } };
        if (heldCase.shape === "contradictory") {
          const contradictory = { accepted: true, retainedUnsentRelease: held };
          Object.defineProperty(contradictory, "deferredBeforeStart", { enumerable: true,
            get: () => { throw new Error("legacy deferral must not be read after retained release presence"); } });
          return contradictory;
        }
        return { accepted: true, retainedUnsentRelease: held };
      }
      throw new Error("unexpected workflow queue row");
    });

    const first = await processQueuedWorkflowToolStepRuns(db, { limit: 7 });
    expect(first).toMatchObject({ claimedCount: 7, executedCount: 1, failedCount: 0, skippedCount: 6 });
    expect(workerManager.isRunning(PLUGIN_DB_ID)).toBe(false);
    if (!oldOwner || !oldProof) throw new Error("positive-unsent owner was not captured");
    expect(oldProof).toMatchObject({ kind: "definitely_unsent", pluginId: PLUGIN_ID, toolName: "publish" });
    const releasedStep = await readStep(retained.stepRunId), legacyStep = await readStep(legacy.stepRunId);
    expect(releasedStep).toMatchObject({ status: "running", lastDispatchAcceptedAt: null,
      metadata: { toolQueue: { status: "queued" }, toolInvocation: { requestId: retained.requestId, toolName: TOOL, args: { order: 0 } } } });
    expect(releasedStep.metadata.toolInvocation).not.toHaveProperty("retainedCompletion");
    expect(legacyStep).toMatchObject({ status: "running", lastDispatchAcceptedAt: null, metadata: { toolQueue: { status: "queued" } } });
    expect(heldSnapshots).toHaveLength(4);
    for (const candidate of heldCases) {
      const receiptId = heldReceiptIds.get(candidate.run.runId);
      if (!receiptId) throw new Error(`held receipt missing for ${candidate.shape}`);
      const snapshot = heldSnapshots.find((item) => item.step.id === candidate.run.stepRunId);
      if (!snapshot) throw new Error(`held snapshot missing for ${candidate.shape}`);
      expect(await readStep(candidate.run.stepRunId)).toEqual(snapshot.step);
      expect(await db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.workflowStepRunId, candidate.run.stepRunId))).toEqual(snapshot.events);
      const [stillExecuting] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, receiptId));
      expect(stillExecuting).toMatchObject({ status: "executing", resultBody: null, resultStatus: null });
    }
    expect((await readStep(progress.stepRunId)).lastDispatchAcceptedAt).toBeInstanceOf(Date);
    const [oldReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, oldOwner.receiptId));
    expect(oldReceipt).toBeUndefined();

    const handle = await workerManager.startWorker(PLUGIN_DB_ID, { entrypointPath: workerPath, manifest, config: {}, apiVersion: 1,
        autoRestart: false, rpcTimeoutMs: 10_000, instanceInfo: { instanceId: "retained-replay", hostVersion: "test" },
        hostHandlers: { "state.get": async () => ({}) }, onStreamNotification: (_method, params) => {
          if (params.event === "tool-started") {
            if (!resolveStarted) throw new Error("tool start listener was not installed");
            toolStarts.push(params); resolveStarted(params);
          }
        } });
    const replayPromise = processQueuedWorkflowToolStepRuns(db, { limit: 1 });
    const streamStarted = await started;
    expect(streamStarted.runId).toBe(retained.runId); expect(streamStarted.starts).toBe(1);
    if (!replayOwner) throw new Error("worker started before the retained owner was captured");
    const activeStep = await readStep(retained.stepRunId);
    expect(activeStep.status).toBe("running"); expect(activeStep.metadata.toolInvocation).toHaveProperty("retainedCompletion");
    const [activeReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, replayOwner.receiptId));
    expect(activeReceipt).toMatchObject({ status: "executing", resultBody: null, resultStatus: null });
    handle.notify("fixture.tool-release", { runId: retained.runId, result: { content: "replayed once", data: { ok: true } } });
    const replay = await replayPromise;
    expect(replay).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0, skippedCount: 0 });
    if (!replayConsumer || !replayOwner) throw new Error("retained replay did not attach its actual consumer");
    await replayConsumer;
    expect(toolStarts).toHaveLength(1);
    const completedStep = await readStep(retained.stepRunId);
    expect(completedStep.status).toBe("completed");
    const [completedReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, replayOwner.receiptId));
    expect(completedReceipt?.status).toBe("completed");
    expect(decodeRetainedToolOutcome(completedReceipt?.resultBody)?.actual).toMatchObject({ kind: "result", result: { content: "replayed once" } });
    const staleRelease = await releaseRetainedWorkflowToolUnsent(db, oldOwner, oldProof);
    expect(staleRelease.kind).toBe("held"); expect(await readStep(retained.stepRunId)).toEqual(completedStep);
    const [stillCompletedReceipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, replayOwner.receiptId));
    expect(stillCompletedReceipt).toEqual(completedReceipt);
    const legacyAgain = await processQueuedWorkflowToolStepRuns(db, { limit: 1 });
    expect(legacyAgain).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 0, skippedCount: 1 });
    expect(toolStarts).toHaveLength(1);
  });
});
