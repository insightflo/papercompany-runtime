import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDb, pluginJobRuns, pluginJobs, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginJobScheduler, type DisabledScheduledPluginJob, type PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const PLUGIN = "cd117a88-e2b3-40cb-9be7-3cced692a001";
const JOB = "cd117a88-e2b3-40cb-9be7-3cced692a002";
const OTHER = "cd117a88-e2b3-40cb-9be7-3cced692a003";
const OTHER_JOB = "cd117a88-e2b3-40cb-9be7-3cced692a004";
const DUE = new Date("2026-10-28T10:00:00.000Z");
const entrypointPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test barrier timed out")), 15_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("plugin scheduler admission and drain", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let schedulers: PluginJobScheduler[];
  let managers: PluginWorkerManager[];
  let gates: Array<() => void>;
  let workerRunId: string | undefined;

  function gate() {
    const value = barrier(); gates.push(() => value.resolve()); return value;
  }
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-scheduler-admission-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values([
      { id: PLUGIN, pluginKey: "fixture.jobs", packageName: "@fixture/jobs", version: "1", manifestJson: {} as never },
      { id: OTHER, pluginKey: "fixture.other", packageName: "@fixture/other", version: "1", manifestJson: {} as never },
    ]);
    await db.insert(pluginJobs).values([
      { id: JOB, pluginId: PLUGIN, jobKey: "publish", schedule: "0 * * * *", nextRunAt: DUE },
      { id: OTHER_JOB, pluginId: OTHER, jobKey: "other", schedule: "0 * * * *" },
    ]);
  }, 120_000);
  beforeEach(async () => {
    schedulers = []; managers = []; gates = []; workerRunId = undefined;
    await db.delete(pluginJobRuns);
    await db.update(pluginJobs).set({ status: "active", schedule: "0 * * * *", nextRunAt: DUE, lastRunAt: null })
      .where(eq(pluginJobs.id, JOB));
  });
  afterEach(async () => {
    for (const resolve of gates) resolve();
    for (const scheduler of schedulers) scheduler.stop();
    for (const manager of managers) if (workerRunId) manager.getWorker(PLUGIN)?.notify("fixture.release", { runId: workerRunId });
    await bounded(Promise.all(schedulers.map((scheduler) => scheduler.drain())));
    await bounded(Promise.all(managers.map((manager) => manager.stopAll())));
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });

  function setup(disabledScheduledJobs: DisabledScheduledPluginJob[] = [], call = vi.fn().mockResolvedValue({})) {
    const store = pluginJobStore(db);
    const lifecycle = createRuntimeExecutionLifecycle();
    const scheduler = createPluginJobScheduler({
      db, jobStore: store, workerManager: { isRunning: () => true, call } as never,
      disabledScheduledJobs, runtimeLifecycle: lifecycle, tickIntervalMs: 60_000,
    });
    schedulers.push(scheduler);
    return { scheduler, store, lifecycle, call };
  }

  function holdClaim(store: ReturnType<typeof pluginJobStore>) {
    const entered = barrier<Awaited<ReturnType<typeof store.claimQueuedRun>>>(); const hold = gate();
    const claim = store.claimQueuedRun.bind(store);
    vi.spyOn(store, "claimQueuedRun").mockImplementation(async (...args) => {
      const result = await claim(...args); entered.resolve(result); await hold.promise; return result;
    });
    return { entered, hold };
  }

  it("waits for both a held claim and its exact release after stop", async () => {
    const { scheduler, store, call } = setup();
    const claim = holdClaim(store); const releasing = barrier(); const releaseGate = gate();
    const release = store.releaseUnstartedClaim.bind(store);
    const spy = vi.spyOn(store, "releaseUnstartedClaim").mockImplementation(async (...args) => {
      releasing.resolve(); await releaseGate.promise; return release(...args);
    });
    const { runId } = await scheduler.triggerJob(JOB);
    const held = await bounded(claim.entered.promise);
    scheduler.stop();
    const drained = scheduler.drain(); await pending(drained);
    claim.hold.resolve(); await bounded(releasing.promise); await pending(drained);
    expect(scheduler.diagnostics().activeJobCount).toBe(1);
    releaseGate.resolve(); await bounded(drained);
    expect(spy).toHaveBeenCalledWith(runId, held!.claimToken);
    expect(await store.getRunById(runId)).toMatchObject({ status: "queued", startedAt: null, claimToken: null });
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["before_write", "after_write"] as const)("keeps drain open after release failure %s", async (failure) => {
    const { scheduler, store, call } = setup(); const claim = holdClaim(store);
    const failed = barrier(); const retrying = barrier(); const retryGate = gate();
    const release = store.releaseUnstartedClaim.bind(store); let attempts = 0;
    vi.spyOn(store, "releaseUnstartedClaim").mockImplementation(async (...args) => {
      if (attempts++ === 0) {
        if (failure === "after_write") await release(...args);
        failed.resolve(); throw new Error("transient release failure");
      }
      retrying.resolve(); await retryGate.promise; return release(...args);
    });
    const { runId } = await scheduler.triggerJob(JOB); await bounded(claim.entered.promise);
    scheduler.stop(); const drained = scheduler.drain(); claim.hold.resolve(); await bounded(failed.promise);
    await new Promise<void>((resolve) => setImmediate(resolve)); await pending(drained);
    await bounded(retrying.promise); await pending(drained);
    retryGate.resolve(); await bounded(drained);
    expect(await store.getRunById(runId)).toMatchObject({ status: "queued", claimToken: null });
    expect(call).not.toHaveBeenCalled();
  });

  it("tracks manual creation and scheduled admission that outlive stop", async () => {
    const manual = setup(); const creating = barrier(); const creationGate = gate();
    const create = manual.store.createRun.bind(manual.store);
    vi.spyOn(manual.store, "createRun").mockImplementation(async (...args) => {
      const run = await create(...args); creating.resolve(); await creationGate.promise; return run;
    });
    const result = manual.scheduler.triggerJob(JOB); await bounded(creating.promise);
    manual.scheduler.stop(); const manualDrain = manual.scheduler.drain(); await pending(manualDrain);
    creationGate.resolve(); const { runId } = await bounded(result); await bounded(manualDrain);
    expect(await manual.store.getRunById(runId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(manual.call).not.toHaveBeenCalled();

    await db.delete(pluginJobRuns);
    const scheduled = setup(); const admitting = barrier(); const admissionGate = gate();
    const admit = scheduled.store.createOrReuseQueuedScheduledRun.bind(scheduled.store);
    vi.spyOn(scheduled.store, "createOrReuseQueuedScheduledRun").mockImplementation(async (...args) => {
      const result = await admit(...args); admitting.resolve(); await admissionGate.promise; return result;
    });
    const tick = scheduled.scheduler.tick(); await bounded(admitting.promise);
    scheduled.scheduler.stop(); const tickDrain = scheduled.scheduler.drain(); await pending(tickDrain);
    admissionGate.resolve(); await bounded(Promise.all([tick, tickDrain]));
    expect(await db.select().from(pluginJobRuns)).toMatchObject([{ status: "queued", scheduledAt: DUE }]);
    expect((await scheduled.store.getJobById(JOB))!.nextRunAt).toEqual(DUE);
    expect(scheduled.call).not.toHaveBeenCalled();
  });

  it("revokes an old claim and replays the same run once after re-registration", async () => {
    const { scheduler, store, call } = setup();
    const run = await store.createRun({ jobId: JOB, pluginId: PLUGIN, trigger: "retry" });
    const claim = holdClaim(store);
    const oldRegistration = scheduler.registerPlugin(PLUGIN); await bounded(claim.entered.promise);
    const unregistered = scheduler.unregisterPlugin(PLUGIN);
    const pluginDrain = scheduler.drain(PLUGIN);
    const registered = scheduler.registerPlugin(PLUGIN);
    await unregistered; await pending(pluginDrain); await pending(registered);
    expect(call).not.toHaveBeenCalled();
    claim.hold.resolve(); await bounded(Promise.all([oldRegistration, pluginDrain, registered]));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({ job: { runId: run.id, trigger: "retry" } });
    expect(await store.getRunById(run.id)).toMatchObject({ status: "succeeded" });
  });

  it("drains one plugin without waiting for another plugin's started job", async () => {
    const started = barrier(); const finishOther = gate();
    const call = vi.fn((pluginId: string) => {
      if (pluginId === OTHER) { started.resolve(); return finishOther.promise; }
      return Promise.resolve({});
    });
    const { scheduler, store } = setup([], call as never);
    await scheduler.triggerJob(OTHER_JOB); await bounded(started.promise);
    const claim = holdClaim(store);
    const result = await scheduler.triggerJob(JOB); await bounded(claim.entered.promise);
    await scheduler.unregisterPlugin(PLUGIN); const pluginDrain = scheduler.drain(PLUGIN); await pending(pluginDrain);
    claim.hold.resolve(); await bounded(pluginDrain);
    expect(await store.getRunById(result.runId)).toMatchObject({ status: "queued" });
    expect(call).toHaveBeenCalledTimes(1);
    finishOther.resolve(); await bounded(scheduler.drain());
  });

  it("blocks native-owned scheduled replay without blocking manual or retry", async () => {
    const { scheduler, store, call } = setup([{ pluginKey: "fixture.jobs", jobKey: "publish" }]);
    const scheduled = (await store.createOrReuseQueuedScheduledRun({ jobId: JOB, pluginId: PLUGIN })).run!;
    const manual = await store.createRun({ jobId: JOB, pluginId: PLUGIN, trigger: "manual" });
    const retry = await store.createRun({ jobId: JOB, pluginId: PLUGIN, trigger: "retry" });
    await scheduler.registerPlugin(PLUGIN); await scheduler.tick();
    expect(call.mock.calls.map((args) => args[2].job.runId)).toEqual([manual.id, retry.id]);
    expect(await store.getRunById(scheduled.id)).toMatchObject({ status: "queued", scheduledAt: DUE, finishedAt: null });
    expect((await store.getJobById(JOB))!.nextRunAt).toEqual(DUE);
  });

  it("does not starve manual work behind more than one page of disabled schedules", async () => {
    const disabled = Array.from({ length: 11 }, (_, index) => ({ pluginKey: "fixture.jobs", jobKey: `disabled-${index}` }));
    const jobs = disabled.map(({ jobKey }) => ({ id: randomUUID(), pluginId: PLUGIN, jobKey, schedule: "0 * * * *", nextRunAt: DUE }));
    const { scheduler, store, call } = setup(disabled);
    await db.insert(pluginJobs).values(jobs);
    try {
      for (const job of jobs) {
        const run = (await store.createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: PLUGIN })).run!;
        await db.update(pluginJobRuns).set({ createdAt: new Date("2020-01-01T00:00:00Z") }).where(eq(pluginJobRuns.id, run.id));
      }
      const manual = await store.createRun({ jobId: JOB, pluginId: PLUGIN, trigger: "manual" });
      await scheduler.registerPlugin(PLUGIN);
      expect(call.mock.calls.map((args) => args[2].job.runId)).toEqual([manual.id]);
      expect(await store.getRunById(manual.id)).toMatchObject({ status: "succeeded" });
    } finally {
      for (const job of jobs) await db.delete(pluginJobs).where(eq(pluginJobs.id, job.id));
    }
  });

  it("checks the current native-owner policy after a blocked claim", async () => {
    const disabled: DisabledScheduledPluginJob[] = [];
    const { scheduler, store, call } = setup(disabled);
    const run = (await store.createOrReuseQueuedScheduledRun({ jobId: JOB, pluginId: PLUGIN })).run!;
    const claim = holdClaim(store); const registration = scheduler.registerPlugin(PLUGIN);
    const held = await bounded(claim.entered.promise);
    disabled.push({ pluginKey: "fixture.jobs", jobKey: "publish" });
    const release = vi.spyOn(store, "releaseUnstartedClaim");
    claim.hold.resolve(); await bounded(registration);
    expect(release).toHaveBeenCalledWith(run.id, held!.claimToken);
    expect(await store.getRunById(run.id)).toMatchObject({ status: "queued", scheduledAt: DUE });
    expect((await store.getJobById(JOB))!.nextRunAt).toEqual(DUE);
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps an old scheduler generation stale across start and permits later replay", async () => {
    const { scheduler, store, call } = setup(); const claim = holdClaim(store);
    const result = await scheduler.triggerJob(JOB); await bounded(claim.entered.promise);
    scheduler.stop(); scheduler.start(); claim.hold.resolve(); await bounded(scheduler.drain());
    expect(await store.getRunById(result.runId)).toMatchObject({ status: "queued" });
    expect(call).not.toHaveBeenCalled();
    await scheduler.registerPlugin(PLUGIN);
    expect(call).toHaveBeenCalledTimes(1);
    expect(await store.getRunById(result.runId)).toMatchObject({ status: "succeeded" });
  });

  it("does not revive a manual lookup admitted before unregister and re-register", async () => {
    const { scheduler, store, call } = setup();
    const entered = barrier(); const lookupGate = gate(); const lookup = store.getJobById.bind(store);
    vi.spyOn(store, "getJobById").mockImplementation(async (...args) => {
      const job = await lookup(...args); entered.resolve(); await lookupGate.promise; return job;
    });
    const trigger = scheduler.triggerJob(JOB); await bounded(entered.promise);
    await scheduler.unregisterPlugin(PLUGIN); const registered = scheduler.registerPlugin(PLUGIN);
    await pending(registered); lookupGate.resolve(); await expect(trigger).rejects.toThrow("plugin_job_scheduler_plugin_unregistered");
    await bounded(registered);
    expect(await db.select().from(pluginJobRuns)).toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
  });

  it("does not reopen global runtime shutdown when the scheduler restarts", async () => {
    const { scheduler, lifecycle, store, call } = setup();
    scheduler.stop(); lifecycle.beginShutdown("SIGTERM"); scheduler.start();
    const { runId } = await scheduler.triggerJob(JOB); await bounded(scheduler.drain());
    expect(await store.getRunById(runId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps an actual worker result and finalization alive across stop", async () => {
    const started = barrier<{ runId: string; starts: number }>(); const finalizing = barrier(); const finishDb = gate();
    const manager = createPluginWorkerManager(); managers.push(manager);
    const handle = await manager.startWorker(PLUGIN, {
      entrypointPath, manifest: {} as never, config: {}, instanceInfo: { instanceId: "test", hostVersion: "1" },
      apiVersion: 1, hostHandlers: {}, onStreamNotification: (_method, params) => {
        if (params.event === "started") started.resolve(params as { runId: string; starts: number });
      },
    });
    const store = pluginJobStore(db); const finalize = store.finalizeClaimedRun.bind(store);
    vi.spyOn(store, "finalizeClaimedRun").mockImplementation(async (...args) => {
      finalizing.resolve(); await finishDb.promise; return finalize(...args);
    });
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: manager,
      runtimeLifecycle: createRuntimeExecutionLifecycle(), jobTimeoutMs: 10_000 });
    schedulers.push(scheduler);
    const run = await scheduler.triggerJob(JOB); workerRunId = run.runId;
    expect(await bounded(started.promise)).toMatchObject({ runId: run.runId, starts: 1 });
    scheduler.stop(); const schedulerDrain = scheduler.drain(); const workerDrain = manager.drainJobs();
    await pending(schedulerDrain); await pending(workerDrain);
    handle.notify("fixture.release", { runId: run.runId }); await bounded(finalizing.promise);
    await pending(schedulerDrain); await pending(workerDrain);
    finishDb.resolve(); await bounded(Promise.all([schedulerDrain, workerDrain]));
    expect(await store.getRunById(run.runId)).toMatchObject({ status: "succeeded", finishedAt: expect.any(Date) });
  });
});
