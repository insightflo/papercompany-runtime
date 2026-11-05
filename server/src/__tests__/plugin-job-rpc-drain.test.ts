import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, pluginJobRuns, pluginJobs, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeQueuedPluginJob } from "../services/plugin-job-replay.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginWorkerManager, type PluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const PLUGIN_ID = "a7eb5796-73e7-49a1-b813-3b39a7376001";
const JOB_ID = "a7eb5796-73e7-49a1-b813-3b39a7376002";
const entrypointPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("test barrier timed out")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function expectPending(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
}
describe("plugin job RPC retention and drain", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let manager: PluginWorkerManager | undefined;
  let currentRunId: string | undefined;
  let ackGate: ReturnType<typeof barrier> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-job-rpc-drain-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values({
      id: PLUGIN_ID, pluginKey: "fixture.rpc", packageName: "@fixture/rpc", version: "1.0.0", manifestJson: {} as never,
    });
    await db.insert(pluginJobs).values({ id: JOB_ID, pluginId: PLUGIN_ID, jobKey: "publish", schedule: "0 * * * *" });
  }, 120_000);
  beforeEach(async () => {
    await db.delete(pluginJobRuns);
    manager = undefined;
    currentRunId = undefined;
    ackGate = undefined;
  });
  afterEach(async () => {
    ackGate?.resolve();
    const handle = manager?.getWorker(PLUGIN_ID);
    if (currentRunId && handle?.retainedJobCount()) handle.notify("fixture.release", { runId: currentRunId });
    if (manager) await bounded(manager.stopAll());
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  async function setup(autoRestart = false) {
    const started = barrier<{ runId: string; starts: number }>();
    const released = barrier();
    const starts: number[] = [];
    manager = createPluginWorkerManager();
    const options: WorkerStartOptions = {
      entrypointPath, manifest: {} as never, config: {}, instanceInfo: { instanceId: "test", hostVersion: "1" },
      apiVersion: 1, hostHandlers: {}, autoRestart,
      onStreamNotification: (_method, params) => {
        if (params.event === "started") {
          starts.push(params.starts as number);
          started.resolve(params as { runId: string; starts: number });
        } else if (params.event === "released") released.resolve();
      },
    };
    const handle = await manager.startWorker(PLUGIN_ID, options);
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: JOB_ID, pluginId: PLUGIN_ID, trigger: "manual" });
    currentRunId = run.id;
    const job = (await store.getJobById(JOB_ID))!;
    const execute = (jobTimeoutMs: number) => executeQueuedPluginJob({
      job, run, jobStore: store, workerManager: manager!, jobTimeoutMs,
      runtimeLifecycle: createRuntimeExecutionLifecycle(),
    });
    return { store, run, job, handle, started, released, starts, execute, manager, options };
  }

  it.each([
    ["stopWorker", "none"], ["stopAll", "none"], ["stopWorker", "before"],
    ["stopAll", "before"], ["stopWorker", "after"], ["stopAll", "after"],
  ] as const)("%s preserves a retained result, with queued restart: %s", async (stopMethod, restartOrder) => {
      const f = await setup();
      const finalizing = barrier(); ackGate = barrier();
      const realFinalize = f.store.finalizeClaimedRun.bind(f.store);
      const finalize = vi.spyOn(f.store, "finalizeClaimedRun").mockImplementation(async (...args) => {
        finalizing.resolve();
        await ackGate!.promise; return realFinalize(...args);
      });
      const execution = f.execute(40);
      expect(await bounded(f.started.promise)).toMatchObject({ runId: f.run.id, starts: 1 });
      expect(await bounded(execution)).toEqual({ kind: "completion_uncertain" });
      expect(f.handle.diagnostics().pendingRequests).toBe(1);
      const claimed = (await f.store.getRunById(f.run.id))!;
      expect(claimed).toMatchObject({ status: "running", completionUncertainty: "external_execution_sent_or_unknown" });
      const statuses: string[] = [];
      f.handle.on("status", ({ status }) => { statuses.push(status); });
      const restartBefore = restartOrder === "before" ? f.handle.restart() : undefined;
      const stopped = stopMethod === "stopAll" ? f.manager.stopAll() : f.manager.stopWorker(PLUGIN_ID);
      const restart = restartBefore ?? (restartOrder === "after" ? f.handle.restart() : Promise.resolve());
      const drained = f.manager.drainJobs();
      try {
        if (restartOrder !== "none") await expectPending(restart);
        await Promise.all([expectPending(stopped), expectPending(drained)]);
        expect(f.handle.status).toBe("running");
        f.handle.notify("fixture.release", { runId: f.run.id });
        await bounded(finalizing.promise);
        if (restartOrder !== "none") await expectPending(restart);
        await Promise.all([expectPending(stopped), expectPending(drained)]);
        expect(f.manager.retainedJobCount()).toBe(1);
        ackGate.resolve();
        const [restartResult, stopResult, drainResult] = await bounded(Promise.allSettled([restart, stopped, drained]));
        expect({ restart: restartResult.status, stop: stopResult.status, drain: drainResult.status, status: f.handle.status,
          pid: f.handle.diagnostics().pid, registered: f.manager.getWorker(PLUGIN_ID),
          run: await f.store.getRunById(f.run.id), starts: f.starts,
        }).toMatchObject({ restart: restartOrder !== "none" ? "rejected" : "fulfilled", stop: "fulfilled", drain: "fulfilled", status: "stopped", pid: null,
          registered: undefined, run: { status: "succeeded", completionUncertainty: null }, starts: [1] });
        expect(statuses).not.toContain("starting");
        expect(f.manager.retainedJobCount()).toBe(0);
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(finalize.mock.calls[0]!.slice(0, 2)).toEqual([f.run.id, claimed.claimToken]);
      } finally {
        ackGate.resolve();
        if (f.handle.retainedJobCount()) f.handle.notify("fixture.release", { runId: f.run.id });
        await bounded(Promise.allSettled([restart, stopped]));
        await bounded(f.handle.stop());
      }
  });

  it("keeps normal restart and a replacement started during stopWorker managed", async () => {
    const f = await setup();
    const originalPid = f.handle.diagnostics().pid;
    await bounded(f.handle.restart());
    expect(f.handle.status).toBe("running");
    expect(f.handle.diagnostics().pid).not.toBe(originalPid);
    await bounded(f.handle.stop()); await bounded(f.handle.restart());
    let replacement!: ReturnType<PluginWorkerManager["startWorker"]>;
    f.handle.on("status", ({ status }) => {
      if (status === "stopped") replacement = f.manager.startWorker(PLUGIN_ID, f.options);
    });
    await bounded(f.manager.stopWorker(PLUGIN_ID));
    const next = await bounded(replacement);
    await expect(f.handle.restart()).rejects.toThrow("cancelled by stop");
    expect(f.manager.getWorker(PLUGIN_ID)).toBe(next);
    expect(next.status).toBe("running");
  });

  it("stops an in-flight start, blocks starts during stopAll, and allows later starts", async () => {
    const f = await setup();
    const starting = f.manager.startWorker("in-flight", f.options);
    let startSettled = false; void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
    const stopping = f.manager.stopAll();
    await expect(f.manager.startWorker("later", f.options)).rejects.toThrow("stopAll is in progress");
    await bounded(stopping); expect(startSettled).toBe(true);
    expect(await bounded(Promise.allSettled([starting, stopping]))).toMatchObject([
      { status: "rejected" }, { status: "fulfilled" },
    ]);
    expect(f.manager.diagnostics()).toEqual([]);
    expect((await bounded(f.manager.startWorker(PLUGIN_ID, f.options))).status).toBe("running");
  });

  it("auto-restarts after a crash but a later stop cancels crash recovery", async () => {
    const f = await setup(true);
    const ready = barrier(); const backoff = barrier();
    f.handle.on("ready", () => ready.resolve());
    f.handle.notify("fixture.crash", {});
    await bounded(ready.promise);
    expect(f.handle.status).toBe("running");
    f.handle.on("status", ({ status }) => { if (status === "backoff") backoff.resolve(); });
    f.handle.notify("fixture.crash", {});
    await bounded(backoff.promise);
    await bounded(f.manager.stopWorker(PLUGIN_ID));
    expect(f.handle.diagnostics()).toMatchObject({ status: "stopped", pid: null, nextRestartAt: null, totalCrashes: 2 });
  });

  it("retries an actual worker failure with the identical token and waits for DB acknowledgement", async () => {
    const f = await setup();
    const realFinalize = f.store.finalizeClaimedRun.bind(f.store);
    const first = barrier(); const second = barrier();
    ackGate = barrier();
    let calls = 0;
    const finalize = vi.spyOn(f.store, "finalizeClaimedRun").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) { first.resolve(); throw new Error("transient database failure"); }
      second.resolve();
      await ackGate!.promise;
      return realFinalize(...args);
    });
    const mark = vi.spyOn(f.store, "markCompletionUncertain");
    const execution = f.execute(10_000);
    const executionResult = execution.then((value) => ({ value }), (error) => ({ error }));
    await bounded(f.started.promise);
    const claimed = (await f.store.getRunById(f.run.id))!;
    f.handle.notify("fixture.release", { runId: f.run.id, error: "actual worker error", code: PLUGIN_RPC_ERROR_CODES.TIMEOUT });
    await bounded(first.promise);
    expect(await bounded(executionResult)).toMatchObject({ error: new Error("transient database failure") });
    const drained = f.manager.drainJobs();
    const stopped = f.manager.stopAll();
    await bounded(second.promise);
    await expectPending(drained);
    await expectPending(stopped);
    expect(f.handle.status).toBe("running");
    expect(mark).not.toHaveBeenCalled();
    expect(await f.store.getRunById(f.run.id)).toMatchObject({ status: "running", completionUncertainty: null });
    expect(finalize.mock.calls).toHaveLength(2);
    expect(finalize.mock.calls[0]).toEqual(finalize.mock.calls[1]);
    expect(finalize.mock.calls[1]!.slice(0, 2)).toEqual([f.run.id, claimed.claimToken]);
    expect(finalize.mock.calls[1]![2]).toMatchObject({ status: "failed", error: "actual worker error" });

    ackGate.resolve();
    await bounded(Promise.all([drained, stopped]));
    expect(await f.store.getRunById(f.run.id)).toMatchObject({ status: "failed", error: "actual worker error" });
    expect(f.starts).toEqual([1]);
    expect(await realFinalize(f.run.id, claimed.claimToken!, { status: "succeeded" })).toBe("already_finalized");
    expect(await realFinalize(f.run.id, randomUUID(), { status: "succeeded" })).toBe("rejected");
  });

  it("serializes uncertainty evidence with a late actual result", async () => {
    const f = await setup();
    const realMark = f.store.markCompletionUncertain.bind(f.store); const entered = barrier();
    ackGate = barrier();
    vi.spyOn(f.store, "markCompletionUncertain").mockImplementation(async (...args) => {
      entered.resolve();
      await ackGate!.promise;
      return realMark(...args);
    });
    const finalize = vi.spyOn(f.store, "finalizeClaimedRun");
    const execution = f.execute(40);
    await bounded(f.started.promise);
    await bounded(entered.promise);
    const drained = f.manager.drainJobs();
    f.handle.notify("fixture.release", { runId: f.run.id });
    await bounded(f.released.promise);
    expect(finalize).not.toHaveBeenCalled();
    await expectPending(drained);
    ackGate.resolve();
    expect(await bounded(execution)).toMatchObject({ kind: "settled", status: "succeeded" });
    await bounded(drained);
    expect(await f.store.getRunById(f.run.id)).toMatchObject({ status: "succeeded", completionUncertainty: null });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(f.starts).toEqual([1]);
  });

  it("releases the exact claim when stop wins immediately before the RPC write", async () => {
    const f = await setup();
    let stopped!: Promise<void>;
    vi.spyOn(f.manager, "isRunning").mockImplementation(() => {
      stopped = f.manager.stopWorker(PLUGIN_ID);
      return true;
    });
    expect(await bounded(f.execute(10_000))).toEqual({ kind: "unavailable_before_start" });
    expect(await f.store.getRunById(f.run.id)).toMatchObject({ status: "queued", startedAt: null, claimToken: null });
    expect(await f.store.listQueuedRunsByPlugin(PLUGIN_ID)).toMatchObject([{ id: f.run.id }]);
    await bounded(stopped);
  });

  it("does not invoke an incompatible manager that lacks observed job RPCs", async () => {
    const f = await setup();
    const call = vi.fn();
    const result = await executeQueuedPluginJob({
      job: f.job, run: f.run, jobStore: f.store, jobTimeoutMs: 10_000,
      workerManager: { isRunning: () => true, getWorker: () => f.handle, call } as never,
      runtimeLifecycle: createRuntimeExecutionLifecycle(),
    });
    expect(result).toEqual({ kind: "unavailable_before_start" });
    expect(call).not.toHaveBeenCalled();
    expect(await f.store.getRunById(f.run.id)).toMatchObject({ status: "queued", claimToken: null });
  });

  it("keeps a lost worker's sent job running, uncertain and unreplayable after evidence is durable", async () => {
    const f = await setup();
    const execution = f.execute(10_000);
    await bounded(f.started.promise);
    f.handle.notify("fixture.crash", {});
    expect(await bounded(execution)).toEqual({ kind: "completion_uncertain" });
    expect(await f.store.getRunById(f.run.id)).toMatchObject({
      status: "running", finishedAt: null, completionUncertainty: "external_execution_sent_or_unknown",
    });
    expect(await f.store.listQueuedRunsByPlugin(PLUGIN_ID)).toEqual([]);
    expect(await f.execute(10_000)).toEqual({ kind: "not_claimed" });
    await bounded(f.manager.drainJobs());
    expect(f.manager.retainedJobCount()).toBe(0);
    await bounded(f.manager.stopAll());
  });
});
