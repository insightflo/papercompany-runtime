import { createDb, pluginJobRuns, pluginJobs, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerAdmission } from "../services/plugin-job-scheduler-admission.js";
import { createPluginJobScheduler, type PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const PLUGIN = "dd117a88-e2b3-40cb-9be7-3cced692a001";
const JOB = "dd117a88-e2b3-40cb-9be7-3cced692a002";
const MANUAL_JOB = "dd117a88-e2b3-40cb-9be7-3cced692a003";
const OTHER = "dd117a88-e2b3-40cb-9be7-3cced692a004";
const OTHER_JOB = "dd117a88-e2b3-40cb-9be7-3cced692a005";
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("test barrier timed out")), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
}

describe("plugin scheduler registration and unresolved identity races", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let schedulers: PluginJobScheduler[];
  let gates: Array<() => void>;

  function gate() {
    const value = barrier(); gates.push(() => value.resolve()); return value;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-scheduler-admission-races-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values([
      { id: PLUGIN, pluginKey: "fixture.registration", packageName: "@fixture/registration", version: "1", manifestJson: {} as never },
      { id: OTHER, pluginKey: "fixture.unrelated", packageName: "@fixture/unrelated", version: "1", manifestJson: {} as never },
    ]);
    await db.insert(pluginJobs).values([
      { id: JOB, pluginId: PLUGIN, jobKey: "queued", schedule: "0 * * * *", nextRunAt: FUTURE },
      { id: MANUAL_JOB, pluginId: PLUGIN, jobKey: "manual", schedule: "0 * * * *", nextRunAt: FUTURE },
      { id: OTHER_JOB, pluginId: OTHER, jobKey: "other", schedule: "0 * * * *", nextRunAt: FUTURE },
    ]);
  }, 120_000);
  beforeEach(async () => { schedulers = []; gates = []; await db.delete(pluginJobRuns); });
  afterEach(async () => {
    for (const resolve of gates) resolve();
    for (const scheduler of schedulers) scheduler.stop();
    await bounded(Promise.all(schedulers.map((scheduler) => scheduler.drain())));
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });

  function setup(call = vi.fn().mockResolvedValue({})) {
    const store = pluginJobStore(db);
    const scheduler = createPluginJobScheduler({
      db, jobStore: store, workerManager: { isRunning: () => true, call } as never,
      runtimeLifecycle: createRuntimeExecutionLifecycle(),
    });
    schedulers.push(scheduler);
    return { store, scheduler, call };
  }

  it("keeps tick, concurrent registration and manual starts behind old plugin DB work", async () => {
    const started = barrier();
    const call = vi.fn().mockImplementation(async () => { started.resolve(); return {}; });
    const { store, scheduler } = setup(call);
    const entered = barrier(); const oldGate = gate(); const listJobs = store.listJobs.bind(store);
    vi.spyOn(store, "listJobs").mockImplementation(async (...args) => {
      const jobs = await listJobs(...args); entered.resolve(); await oldGate.promise; return jobs;
    });
    const oldRegistration = scheduler.registerPlugin(PLUGIN); await bounded(entered.promise);
    const queued = await store.createRun({ jobId: JOB, pluginId: PLUGIN, trigger: "retry" });
    await scheduler.unregisterPlugin(PLUGIN);
    const first = scheduler.registerPlugin(PLUGIN);
    const second = scheduler.registerPlugin(PLUGIN);
    const tick = scheduler.tick();
    const manual = scheduler.triggerJob(MANUAL_JOB).catch((error: unknown) => error);
    const result = await bounded(manual); await bounded(tick);
    if (!(result instanceof Error)) await bounded(started.promise);
    expect(call).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
    await pending(first); await pending(second);
    oldGate.resolve(); await bounded(Promise.all([oldRegistration, first, second]));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({ job: { runId: queued.id, trigger: "retry" } });
    expect(await store.getRunById(queued.id)).toMatchObject({ status: "succeeded" });
  });

  it("follows an unresolved lookup through its later claim and exact unstarted release", async () => {
    const { store, scheduler, call } = setup();
    const entered = barrier(); const lookupGate = gate(); const getJob = store.getJobById.bind(store);
    vi.spyOn(store, "getJobById").mockImplementation(async (...args) => {
      const job = await getJob(...args); entered.resolve(); await lookupGate.promise; return job;
    });
    const claimed = barrier<Awaited<ReturnType<typeof store.claimQueuedRun>>>(); const claimGate = gate();
    const claim = store.claimQueuedRun.bind(store);
    vi.spyOn(store, "claimQueuedRun").mockImplementation(async (...args) => {
      const run = await claim(...args); claimed.resolve(run); await claimGate.promise; return run;
    });
    const release = vi.spyOn(store, "releaseUnstartedClaim");
    const trigger = scheduler.triggerJob(JOB); await bounded(entered.promise);
    const drained = scheduler.drain(PLUGIN); await pending(drained);
    lookupGate.resolve(); const { runId } = await bounded(trigger); const held = await bounded(claimed.promise);
    await pending(drained); await scheduler.unregisterPlugin(PLUGIN);
    claimGate.resolve(); await bounded(drained);
    expect(release).toHaveBeenCalledWith(runId, held!.claimToken);
    expect(await store.getRunById(runId)).toMatchObject({ status: "queued", claimToken: null, startedAt: null });
    expect(call).not.toHaveBeenCalled();
  });

  it("waits for an admitted unresolved lookup without following future unrelated lookups", async () => {
    const started = barrier(); const finishOther = gate();
    const call = vi.fn((pluginId: string) => {
      if (pluginId === OTHER) { started.resolve(); return finishOther.promise; }
      return Promise.resolve({});
    });
    const { store, scheduler } = setup(call as never);
    const oldEntered = barrier(); const futureEntered = barrier();
    const oldGate = gate(); const futureGate = gate(); const getJob = store.getJobById.bind(store);
    vi.spyOn(store, "getJobById").mockImplementation(async (id) => {
      const job = await getJob(id);
      if (id === JOB) { oldEntered.resolve(); await oldGate.promise; }
      if (id === OTHER_JOB) { futureEntered.resolve(); await futureGate.promise; }
      return job;
    });
    const oldTrigger = scheduler.triggerJob(JOB).catch((error: unknown) => error);
    await bounded(oldEntered.promise); await scheduler.unregisterPlugin(PLUGIN);
    const drained = scheduler.drain(PLUGIN); const registered = scheduler.registerPlugin(PLUGIN);
    await pending(drained); await pending(registered);
    const unrelated = scheduler.triggerJob(OTHER_JOB);
    await bounded(futureEntered.promise);
    oldGate.resolve();
    expect(await bounded(oldTrigger)).toMatchObject({ message: "plugin_job_scheduler_plugin_unregistered" });
    await bounded(Promise.all([drained, registered]));
    await pending(unrelated);
    expect(call).not.toHaveBeenCalled();
    futureGate.resolve(); await bounded(unrelated); await bounded(started.promise);
    await bounded(scheduler.drain(PLUGIN));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toBe(OTHER);
    finishOther.resolve(); await bounded(scheduler.drain());
  });
});

it("invalidates pending concurrent registrations when a later revoke occurs without self-wait", async () => {
  const admission = createSchedulerAdmission();
  const old = admission.enter(PLUGIN)!;
  admission.revoke(PLUGIN);
  const first = admission.register(PLUGIN); const firstOperation = admission.enter(PLUGIN)!;
  const second = admission.register(PLUGIN); const secondOperation = admission.enter(PLUGIN)!;
  admission.revoke(PLUGIN);
  const third = admission.register(PLUGIN); const thirdOperation = admission.enter(PLUGIN)!;
  await pending(first); await pending(second); await pending(third);
  old.done(); await bounded(Promise.all([first, second]));
  expect(admission.valid(firstOperation.snapshot, PLUGIN)).toBe(false);
  expect(admission.valid(secondOperation.snapshot, PLUGIN)).toBe(false);
  await pending(third);
  firstOperation.done(); secondOperation.done(); await bounded(third);
  expect(admission.valid(thirdOperation.snapshot, PLUGIN)).toBe(true);
  thirdOperation.done(); await bounded(admission.drain());
});
