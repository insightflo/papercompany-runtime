// @vitest-environment node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  heartbeatRuns, issueWorkProducts, missions, pluginToolExecutionReceipts, plugins, workflowDefinitions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns,
} from "@paperclipai/db";
import { decodeRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import { seedSupervisionLifecycle } from "./helpers/mission-supervision-lifecycle.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";
import { runtimeShutdownScenario, type RuntimeShutdownScenarioResult } from "./helpers/runtime-shutdown-producer.js";

describe("runtime shutdown with real child process", () => {
  let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
  beforeAll(async () => { f = await startRuntimeShutdownProcessFixture({ parentWorkflowAdmission: true }); }, 120_000);
  afterAll(async () => { await f?.cleanup(); });

  const queueStatus = (row: { metadata: Record<string, unknown> }) => {
    const queue = row.metadata.toolQueue;
    return queue && typeof queue === "object" ? (queue as Record<string, unknown>).status : undefined;
  };

  // scenario() moved to helpers/runtime-shutdown-producer.ts (shared with the native producer variant).
  const qaCompleted = async (s: RuntimeShutdownScenarioResult) =>
    f.waitFor(async () => (await s.qaStep()).status === "completed" ? true : null, "QA completion");
  const expectRetryBudgetPreserved = async (s: RuntimeShutdownScenarioResult) => {
    const definition = (await f.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, s.definitionId)))[0]!;
    const qa = (definition.stepsJson as Array<Record<string, unknown>>).find((step) => step.id === "qa");
    expect(qa?.maxRetries).toBe(s.maxRetries);
  };
  const missionCompleted = async (s: RuntimeShutdownScenarioResult) => {
    await s.finishMission();
    return (await f.db.select().from(missions).where(eq(missions.id, s.missionId)))[0];
  };

  it("keeps started A alive through duplicate signals, late QA result, and mission finalization", async () => {
    const s = await runtimeShutdownScenario(f, "started-a");
    const server = await f.startServer();
    await s.completeProducer();
    const started = await f.waitFor(async () => (await f.events(s.eventsFile)).find((row) => row.event === "started") ?? null,
      "recording process start");
    f.recordEvidence("A", server, { recorderPid: started.identity.pid, workflowRunId: s.runId,
      stepRunId: started.identity.stepId, requestId: started.identity.requestId,
      executionGeneration: started.identity.executionGeneration });
    expect(started.identity.workflowRunId).toBe(s.runId);
    server.signal("SIGTERM");
    await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "SIGTERM handler entry");
    server.signal("SIGINT");
    await f.writeGate(s.gateFile);
    expect((await server.waitExit()).code).toBe(0);
    await qaCompleted(s);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    expect((await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.runId)))[0]?.status).toBe("completed");
    expect((await f.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.producerIssueId)))[0]?.metadata)
      .toMatchObject({ registeredVia: "workflow_api" });
    expect((await missionCompleted(s))?.status).toBe("completed");
    expect(server.logs().match(/Server shutting down/g)).toHaveLength(1);
  }, 120_000);
  it("verifies the native process-adapter producer proof chain inside the scenario", async () => {
    const s = await runtimeShutdownScenario(f, "native-producer-proof");
    const producer = s.nativeProducer!;
    const run = await producer.heartbeatRun();
    expect(run?.status).toBe("succeeded");
    expect(producer.proof.processIdentity?.recordPid).toBe(producer.proof.processIdentity?.trackedChildPid);
    expect((await producer.records()).filter((row) => row.event === "started")).toHaveLength(1);
    // No extra owner model runs: the paused mission owner never produced a heartbeat run.
    expect(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.agentId))).toEqual([]);
    const stored = (await f.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, producer.proof.productId!)))[0]!;
    expect(stored.createdByRunId).toBe(run!.id);
    expect(stored.metadata).toMatchObject({ registeredVia: "workflow_api", registeredByRunId: run!.id,
      workflowProducer: { heartbeatRunId: run!.id, retryCount: 0, iterationIndex: 0 } });
    // settle() already asserted the finalizer's state: producer step completed, issue done, QA queued
    // with requestId set and acceptedAt null. completeProducer() re-runs the native completion
    // idempotently; QA must not have completed (no tool child accepted the dispatch yet).
    const settledQa = await s.qaStep();
    expect(settledQa.status).not.toBe("completed");
    expect(settledQa.lastDispatchRequestId).toBeTruthy();
    expect(settledQa.lastDispatchAcceptedAt).toBeNull();
    await s.completeProducer();
    await f.writeGate(s.gateFile);
    const server = await f.startServer();
    await qaCompleted(s);
    // acceptWorkflowToolResult persists the step completion, records the transition, then syncs
    // the run: wait bounded for the run row instead of reading it immediately after the step write.
    await f.waitFor(async () => (await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.runId)))[0]?.status === "completed" ? true : null,
      "native producer workflow run completion");
    expect((await missionCompleted(s))?.status).toBe("completed");
    server.signal("SIGTERM");
    expect((await server.waitExit()).code).toBe(0);
  }, 180_000);
  it("retains positively unstarted B across shutdown and replays the same pinned QA attempt once", async () => {
    const s = await runtimeShutdownScenario(f, "unstarted-b");
    await s.completeProducer();
    const original = await f.waitFor(async () => {
      const row = await s.qaStep();
      return row.lastDispatchRequestId && row.lastDispatchAcceptedAt === null && queueStatus(row) === "queued" ? row : null;
    }, "queued QA intent");
    const activeRuns = await f.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.status, "running"));
    expect(activeRuns.map((row) => row.id)).toEqual([s.runId]);
    const pinsBefore = await f.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, original.id));
    const lock = await f.holdWorkflowStepRun(original.id);
    const server = await f.startServer();
    const blocked = await f.waitForBlocker(lock.pid, "workflow_step_runs", server.applicationName);
    f.recordEvidence("B", server, { holderPid: lock.pid, blockedBackendPid: blocked.pid,
      stepRunId: original.id, requestId: original.lastDispatchRequestId, blockers: blocked.blockers, query: blocked.query });
    expect(String(blocked.query)).toMatch(/for\s+update/i);
    expect(String(blocked.query)).toMatch(/workflow_step_runs/i);
    server.signal("SIGTERM");
    await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "SIGTERM handler entry");
    server.signal("SIGINT"); lock.release(); await lock.done;
    expect((await server.waitExit()).code).toBe(0);
    expect(await f.events(s.eventsFile)).toEqual([]);
    const deferred = await s.qaStep();
    expect(deferred).toMatchObject({ id: original.id, workflowRunId: original.workflowRunId, stepId: original.stepId,
      lastDispatchRequestId: original.lastDispatchRequestId, executionGeneration: original.executionGeneration,
      startedAt: original.startedAt, retryCount: original.retryCount, iterationIndex: original.iterationIndex,
      lastDispatchAcceptedAt: null });
    expect(queueStatus(deferred)).toBe("queued");
    await expectRetryBudgetPreserved(s);
    expect(await f.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, original.id))).toEqual(pinsBefore);
    await f.writeGate(s.gateFile);
    const restarted = await f.startServer();
    await qaCompleted(s);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toMatchObject([
      { nonce: "unstarted-b", identity: { requestId: original.lastDispatchRequestId, workflowRunId: s.runId,
        executionGeneration: original.executionGeneration } },
    ]);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    await expectRetryBudgetPreserved(s);
    restarted.signal("SIGTERM"); expect((await restarted.waitExit()).code).toBe(0);
    expect((await s.qaStep()).retryCount).toBe(0);
    expect((await missionCompleted(s))?.status).toBe("completed");
    const nextTick = await runtimeShutdownScenario(f, "unstarted-b-next-tick");
    await f.writeGate(nextTick.gateFile);
    await nextTick.completeProducer();
    const secondRestart = await f.startServer();
    const nextStarted = await f.waitFor(async () => (await f.events(nextTick.eventsFile)).find((row) => row.event === "started") ?? null,
      "post-replay normal scheduler tick");
    f.recordEvidence("B-second-restart", secondRestart, { recorderPid: nextStarted.identity.pid,
      workflowRunId: nextTick.runId, stepRunId: nextStarted.identity.stepId, requestId: nextStarted.identity.requestId,
      originalBStarts: (await f.events(s.eventsFile)).filter((row) => row.event === "started").length });
    await qaCompleted(nextTick);
    await f.waitFor(async () => (await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, nextTick.runId)))[0]?.status === "completed" ? true : null,
      "post-replay workflow run completion");
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    expect((await missionCompleted(nextTick))?.status).toBe("completed");
    secondRestart.signal("SIGTERM"); expect((await secondRestart.waitExit()).code).toBe(0);
  }, 180_000);
  it("defers preparation C after a real secret lookup lock and never starts its process", async () => {
    const s = await runtimeShutdownScenario(f, "preparation-c", true);
    // The finalizer already queued QA inside scenario(), so the server would accept that dispatch on
    // its first tick: hold the real secret_versions lock before startServer so the lookup blocks.
    const lock = await f.holdSecretVersions();
    const server = await f.startServer();
    await s.completeProducer();
    const blocked = await f.waitForBlocker(lock.pid, "company_secret_versions", server.applicationName);
    const admitted = await s.qaStep();
    f.recordEvidence("C", server, { holderPid: lock.pid, blockedBackendPid: blocked.pid,
      stepRunId: admitted.id, requestId: admitted.lastDispatchRequestId, blockers: blocked.blockers, query: blocked.query });
    expect(String(blocked.query)).toMatch(/select/i);
    const pinsBefore = await f.db.select().from(workflowStepOutputBindings)
      .where(eq(workflowStepOutputBindings.consumerStepRunId, admitted.id));
    server.signal("SIGTERM");
    await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "SIGTERM handler entry");
    server.signal("SIGINT"); lock.release(); await lock.done;
    expect((await server.waitExit()).code).toBe(0);
    expect(await f.events(s.eventsFile)).toEqual([]);
    const deferred = await s.qaStep();
    expect(deferred).toMatchObject({ id: admitted.id, workflowRunId: admitted.workflowRunId, stepId: admitted.stepId,
      status: "running", startedAt: admitted.startedAt, lastDispatchRequestId: admitted.lastDispatchRequestId,
      executionGeneration: admitted.executionGeneration, retryCount: admitted.retryCount, iterationIndex: admitted.iterationIndex,
      lastDispatchAcceptedAt: null });
    expect(queueStatus(deferred)).toBe("queued");
    expect(await f.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, admitted.id)))
      .toEqual(pinsBefore);
    await expectRetryBudgetPreserved(s);
    await f.writeGate(s.gateFile);
    const restarted = await f.startServer();
    await qaCompleted(s);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toMatchObject([
      { nonce: "preparation-c", identity: { requestId: deferred.lastDispatchRequestId, workflowRunId: s.runId,
        executionGeneration: deferred.executionGeneration }, secretResolved: true },
    ]);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    await expectRetryBudgetPreserved(s);
    restarted.signal("SIGTERM"); expect((await restarted.waitExit()).code).toBe(0);
    expect((await missionCompleted(s))?.status).toBe("completed");
  }, 120_000);
  it("does not replay or terminalize an unresolved accepted attempt after forced server exit", async () => {
    const s = await runtimeShutdownScenario(f, "forced-unresolved-a");
    const server = await f.startServer();
    await s.completeProducer();
    const started = await f.waitFor(async () => (await f.events(s.eventsFile)).find((row) => row.event === "started") ?? null,
      "forced-case recording process start");
    f.recordEvidence("forced-unresolved", server, { recorderPid: started.identity.pid, workflowRunId: s.runId,
      stepRunId: started.identity.stepId, requestId: started.identity.requestId,
      executionGeneration: started.identity.executionGeneration });
    const before = await s.qaStep();
    server.signal("SIGKILL");
    expect((await server.waitExit()).signal).toBe("SIGKILL");
    const recorderPid = Number(started.identity.pid);
    await f.writeGate(s.cancelFile);
    try { process.kill(recorderPid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await f.waitForProcessExit(recorderPid);
    const restarted = await f.startServer();
    const witness = await runtimeShutdownScenario(f, "forced-restart-witness");
    await f.writeGate(witness.gateFile);
    await witness.completeProducer();
    await f.waitFor(async () => (await f.events(witness.eventsFile)).find((row) => row.event === "started") ?? null,
      "post-restart scheduler witness");
    await qaCompleted(witness);
    const run = (await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.runId)))[0]!;
    expect(run.status).toBe("running");
    expect(await s.qaStep()).toMatchObject({ id: before.id, status: "running", lastDispatchRequestId: before.lastDispatchRequestId,
      executionGeneration: before.executionGeneration, retryCount: before.retryCount, completedAt: null });
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    expect((await missionCompleted(s))?.status).toBe("active");
    // The replacement server owes nothing to the already-dead original child (its execution
    // tracker is process-local): await its clean drain-and-exit, then assert durable preservation.
    restarted.signal("SIGTERM");
    expect((await restarted.waitExit()).code).toBe(0);
    expect((await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.runId)))[0]?.status).toBe("running");
    const afterExit = await s.qaStep();
    expect(afterExit).toMatchObject({ id: before.id, status: "running",
      lastDispatchRequestId: before.lastDispatchRequestId, lastDispatchAcceptedAt: before.lastDispatchAcceptedAt,
      executionGeneration: before.executionGeneration, retryCount: before.retryCount, iterationIndex: before.iterationIndex,
      completedAt: null });
    expect(afterExit.metadata).toEqual(before.metadata);
    expect((await f.events(s.eventsFile)).filter((row) => row.event === "started")).toHaveLength(1);
    expect((await missionCompleted(s))?.status).toBe("active");
    expect((await missionCompleted(witness))?.status).toBe("completed");
  }, 150_000);
  it("drains the existing real plugin worker's late HTTP result after RPC timeout and SIGTERM", async () => {
    const owner = await seedSupervisionLifecycle(f.db, "active", null);
    const eventsFile = path.join(f.root, "plugin-worker.jsonl"), recordFile = path.join(f.root, "plugin-result.jsonl");
    const gateFile = path.join(f.root, "plugin-result.gate"), nonce = "late-plugin-result";
    const fixture = await f.preparePluginFixture({ eventsFile, recordFile, gateFile, nonce });
    const pluginId = randomUUID();
    await f.db.insert(plugins).values({ id: pluginId, pluginKey: "fixture.plugin", packageName: fixture.packageName,
      version: "1.0.0", manifestJson: fixture.manifest as never, status: "ready", packagePath: fixture.packagePath });
    const server = await f.startServer(fixture.home, fixture.env);
    await f.waitFor(async () => server.logs().includes("plugin activated successfully") ? true : null, "real plugin activation");
    const displayRunId = randomUUID(), tool = "fixture.plugin:publish", idempotencyKey = "late-result";
    const responsePromise = fetch(server.url + "/api/plugins/tools/execute", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, parameters: { marker: nonce }, runContext: { agentId: owner.agentId, runId: displayRunId, companyId: owner.companyId }, idempotencyKey }) });
    // Guard: an earlier waitFor failure must not leave this fetch as an unhandled rejection during
    // cleanup; the awaited result below still propagates a genuine network failure.
    void responsePromise.catch(() => {});
    const workerStart = await f.waitFor(async () => (await f.events(eventsFile)).find((row) => row.event === "tool-started") ?? null, "actual plugin worker tool start");
    const findReceipt = async () => (await f.db.select().from(pluginToolExecutionReceipts).where(and(
      eq(pluginToolExecutionReceipts.companyId, owner.companyId), eq(pluginToolExecutionReceipts.runId, displayRunId),
      eq(pluginToolExecutionReceipts.tool, tool), eq(pluginToolExecutionReceipts.idempotencyKey, idempotencyKey))))[0];
    const executing = await f.waitFor(async () => { const row = await findReceipt(); return row?.status === "executing" ? row : null; }, "durable executing plugin receipt");
    // The consumer executes with runContext.runId = owner.identity.runId (= displayRunId for a keyed
    // claim); executing.id is the receipt UUID used only as requestId/attemptId, not the worker run id.
    expect(workerStart.runId).toBe(displayRunId);
    expect(executing).toMatchObject({ companyId: owner.companyId, runId: displayRunId, tool, idempotencyKey });
    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("timed out");
    expect((await f.events(recordFile)).filter((row) => row.event === "completed")).toHaveLength(0);
    f.recordEvidence("plugin-late-rpc", server, { displayRunId, receiptId: executing.id, workerRunId: workerStart.runId,
      workerPid: workerStart.workerPid, rpcTimeoutObserved: true });
    server.signal("SIGTERM");
    await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "plugin SIGTERM handler entry");
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(server.child.exitCode).toBeNull();
    expect((await findReceipt())?.status).toBe("executing");
    await f.writeGate(gateFile);
    expect((await server.waitExit()).code).toBe(0);
    const produced = await f.waitFor(async () => (await f.events(recordFile)).find((row) => row.event === "completed") ?? null, "recording process actual plugin result");
    const completed = await findReceipt();
    expect(completed?.status).toBe("completed");
    expect(decodeRetainedToolOutcome(completed?.resultBody)?.actual).toMatchObject({ kind: "result", result: produced.result });
    expect((await f.events(eventsFile)).filter((row) => row.event === "tool-started")).toHaveLength(1);
    expect((await f.events(eventsFile)).filter((row) => row.event === "worker-release-sent")).toHaveLength(1);
    expect(server.logs().match(/Server shutting down/g)).toHaveLength(1);
  }, 180_000);
});
