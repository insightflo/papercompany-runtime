import { fileURLToPath } from "node:url";
import { createDb, pluginJobRuns, pluginJobs, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginJobCoordinator } from "../services/plugin-job-coordinator.js";
import { createPluginJobScheduler, type PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
const PLUGIN = "a7eb5796-73e7-49a1-b813-3b39a7376101";
const JOB = "a7eb5796-73e7-49a1-b813-3b39a7376102";
const OTHER = "a7eb5796-73e7-49a1-b813-3b39a7376103";
const OTHER_JOB = "a7eb5796-73e7-49a1-b813-3b39a7376104";
const KEY = "fixture.drain";
const entrypointPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
function barrier<T = void>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test barrier timed out")), 15_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function pending(promise: Promise<unknown>) {
  let settled = false; void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
}
function services(manager: unknown, scheduler: unknown) {
  const clearPlugin = vi.fn(); const unregisterPluginTools = vi.fn();
  const runtime = {
    workerManager: manager, jobScheduler: scheduler, eventBus: { clearPlugin }, toolDispatcher: { unregisterPluginTools },
    instanceInfo: { instanceId: "test", hostVersion: "1" },
  } as unknown as PluginRuntimeServices;
  return { runtime, clearPlugin, unregisterPluginTools };
}
function fakeRuntime() {
  const scheduler = { unregisterPlugin: vi.fn().mockResolvedValue(undefined), drain: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const manager = {
    isRunning: vi.fn(() => false), getWorker: vi.fn(() => ({})), stopWorker: vi.fn().mockResolvedValue(undefined), drainJobs: vi.fn().mockResolvedValue(undefined), stopAll: vi.fn().mockResolvedValue(undefined),
  };
  return { scheduler, manager, ...services(manager, scheduler) };
}
describe("plugin runtime resource drains", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let scheduler: PluginJobScheduler | undefined;
  let manager: PluginWorkerManager | undefined;
  let releases: Array<() => void>;
  let startedRuns: Array<{ pluginId: string; runId: string }>;
  function gate() { const value = barrier(); releases.push(() => value.resolve()); return value; }
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-runtime-drain-"); db = createDb(tempDb.connectionString);
    await db.insert(plugins).values([
      { id: PLUGIN, pluginKey: KEY, packageName: "@fixture/drain", version: "1", status: "ready", manifestJson: {} as never }, { id: OTHER, pluginKey: "fixture.other-drain", packageName: "@fixture/other", version: "1", status: "ready", manifestJson: {} as never },
    ]);
    await db.insert(pluginJobs).values([
      { id: JOB, pluginId: PLUGIN, jobKey: "publish", schedule: "0 * * * *" }, { id: OTHER_JOB, pluginId: OTHER, jobKey: "other", schedule: "0 * * * *" },
    ]);
  }, 120_000);
  beforeEach(async () => {
    scheduler = undefined; manager = undefined; releases = []; startedRuns = []; await db.delete(pluginJobRuns); await db.update(plugins).set({ status: "ready", manifestJson: {} as never }).where(eq(plugins.id, PLUGIN));
  });
  afterEach(async () => {
    for (const release of releases) release();
    scheduler?.stop();
    for (const run of startedRuns) manager?.getWorker(run.pluginId)?.notify("fixture.release", { runId: run.runId });
    if (scheduler) await bounded(scheduler.drain()); if (manager) await bounded(manager.stopAll());
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });
  async function realRuntime(timeout = 40, skipPlugin = false) {
    const store = pluginJobStore(db); manager = createPluginWorkerManager();
    scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: manager,
      jobTimeoutMs: timeout, runtimeLifecycle: createRuntimeExecutionLifecycle() });
    const notifications = new Map<string, ReturnType<typeof barrier<string>>>();
    for (const pluginId of skipPlugin ? [OTHER] : [PLUGIN, OTHER]) {
      const started = barrier<string>(); notifications.set(pluginId, started);
      await manager.startWorker(pluginId, {
        entrypointPath, manifest: {} as never, config: {}, apiVersion: 1, hostHandlers: {}, autoRestart: false,
        instanceInfo: { instanceId: "test", hostVersion: "1" },
        onStreamNotification: (_method, params) => {
          if (params.event === "started") {
            const runId = params.runId as string; startedRuns.push({ pluginId, runId }); started.resolve(runId);
          }
        },
      });
    }
    const s = services(manager, scheduler);
    return { store, manager, scheduler, notifications, ...s, loader: pluginLoader(db, {}, s.runtime) };
  }
  it("waits for an actual claim and release while another plugin completes", async () => {
    const f = await realRuntime(5_000); const claimed = barrier(); const claimGate = gate();
    const releasing = barrier(); const releaseGate = gate();
    const claim = f.store.claimQueuedRun.bind(f.store);
    vi.spyOn(f.store, "claimQueuedRun").mockImplementation(async (...args) => {
      const result = await claim(...args);
      if (result?.pluginId === PLUGIN) { claimed.resolve(); await claimGate.promise; }
      return result;
    });
    const release = f.store.releaseUnstartedClaim.bind(f.store);
    vi.spyOn(f.store, "releaseUnstartedClaim").mockImplementation(async (...args) => {
      releasing.resolve(); await releaseGate.promise; return release(...args);
    });
    const stop = vi.spyOn(f.manager, "stopWorker");
    const { runId } = await f.scheduler.triggerJob(JOB); await bounded(claimed.promise);
    const unloading = f.loader.unloadSingle(PLUGIN, KEY);
    await pending(unloading); await expect(f.scheduler.triggerJob(JOB)).rejects.toThrow("plugin_job_scheduler_plugin_unregistered");
    expect(stop).not.toHaveBeenCalled();
    expect(f.clearPlugin).not.toHaveBeenCalled(); expect(f.unregisterPluginTools).not.toHaveBeenCalled();
    const other = await f.scheduler.triggerJob(OTHER_JOB);
    expect(await bounded(f.notifications.get(OTHER)!.promise)).toBe(other.runId);
    f.manager.getWorker(OTHER)!.notify("fixture.release", { runId: other.runId });
    await bounded(f.scheduler.drain(OTHER));
    expect(await f.store.getRunById(other.runId)).toMatchObject({ status: "succeeded" });
    claimGate.resolve(); await bounded(releasing.promise); await pending(unloading);
    expect(stop).not.toHaveBeenCalled(); expect(f.clearPlugin).not.toHaveBeenCalled();
    releaseGate.resolve(); await bounded(unloading);
    expect(await f.store.getRunById(runId)).toMatchObject({ status: "queued", startedAt: null, claimToken: null });
    expect(f.manager.isRunning(OTHER)).toBe(true);
    expect(f.clearPlugin).toHaveBeenCalledWith(KEY); expect(f.unregisterPluginTools).toHaveBeenCalledWith(KEY);
  });
  it("retains resources until a real worker result is acknowledged by the database", async () => {
    const f = await realRuntime(); const finalizing = barrier(); const ack = gate();
    const finalize = f.store.finalizeClaimedRun.bind(f.store);
    vi.spyOn(f.store, "finalizeClaimedRun").mockImplementation(async (...args) => {
      finalizing.resolve(); await ack.promise; return finalize(...args);
    });
    const { runId } = await f.scheduler.triggerJob(JOB);
    expect(await bounded(f.notifications.get(PLUGIN)!.promise)).toBe(runId);
    await bounded(f.scheduler.drain(PLUGIN));
    const unloading = f.loader.unloadSingle(PLUGIN, KEY); await pending(unloading);
    expect(f.clearPlugin).not.toHaveBeenCalled(); expect(f.unregisterPluginTools).not.toHaveBeenCalled();
    f.manager.getWorker(PLUGIN)!.notify("fixture.release", { runId });
    await bounded(finalizing.promise); await pending(unloading);
    expect(f.clearPlugin).not.toHaveBeenCalled(); expect(f.manager.retainedJobCount()).toBe(1);
    ack.resolve(); await bounded(unloading);
    expect(await f.store.getRunById(runId)).toMatchObject({ status: "succeeded", completionUncertainty: null });
    expect(f.clearPlugin).toHaveBeenCalledWith(KEY); expect(f.unregisterPluginTools).toHaveBeenCalledWith(KEY);
  });
  it.each(["loader", "coordinator", "shutdown"] as const)("does not reopen starts from delayed %s registration during teardown", async (source) => {
    const f = await realRuntime(40, true); const lookup = barrier(); const lookupGate = gate();
    const syncEntered = barrier(); const syncGate = gate(); const finalizing = barrier(); const registered = barrier();
    const decision = barrier<"sent" | "unsent">(); const enabled = barrier();
    let other: Promise<unknown> | undefined; let later = false; let laterRun: string | undefined;
    releases.push(() => { if (laterRun) f.manager.getWorker(PLUGIN)?.notify("fixture.release", { runId: laterRun }); });
    await db.update(plugins).set({ status: "installed", manifestJson: {
      id: KEY, apiVersion: 1, version: "1", entrypoints: { worker: entrypointPath },
      jobs: [{ jobKey: "publish", displayName: "Publish", schedule: "0 * * * *" }],
    } as never }).where(eq(plugins.id, PLUGIN));
    Object.assign(f.runtime.eventBus, { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0) });
    f.runtime.jobStore = f.store; f.runtime.buildHostHandlers = () => ({});
    const lifecycle = pluginLifecycleManager(db, { loader: f.loader, workerManager: f.manager });
    f.runtime.lifecycleManager = lifecycle;
    const coordinator = createPluginJobCoordinator({ db, lifecycle, scheduler: f.scheduler, jobStore: f.store });
    coordinator.start(); releases.push(() => coordinator.stop());
    const sync = f.store.syncJobDeclarations.bind(f.store); let syncCount = 0;
    vi.spyOn(f.store, "syncJobDeclarations").mockImplementation((...args) => {
      const result = sync(...args);
      if (++syncCount === (source === "coordinator" ? 2 : 1)) { void result.then(() => syncEntered.resolve()); return syncGate.promise; }
      return result;
    });
    const loading = lifecycle.load(PLUGIN).catch((error: unknown) => error);
    if (source === "coordinator") await loading;
    await bounded(syncEntered.promise);
    const getJob = f.store.getJobById.bind(f.store);
    vi.spyOn(f.store, "getJobById").mockImplementation(async (id) => {
      const job = await getJob(id);
      if (id === OTHER_JOB) { lookup.resolve(); await lookupGate.promise; }
      return job;
    });
    const register = f.scheduler.registerPlugin.bind(f.scheduler);
    vi.spyOn(f.scheduler, "registerPlugin").mockImplementation((id) => {
      const result = register(id); other ??= f.scheduler.triggerJob(OTHER_JOB).catch(() => undefined);
      void result.then(() => registered.resolve()); return result;
    });
    const unregister = f.scheduler.unregisterPlugin.bind(f.scheduler);
    vi.spyOn(f.scheduler, "unregisterPlugin").mockImplementation((id) => {
      const result = unregister(id); syncGate.resolve(); return result;
    });
    const stop = f.scheduler.stop.bind(f.scheduler);
    vi.spyOn(f.scheduler, "stop").mockImplementation(() => { stop(); syncGate.resolve(); });
    const observe = f.manager.observeJob.bind(f.manager);
    vi.spyOn(f.manager, "observeJob").mockImplementation((...args) => {
      const observed = observe(...args); decision.resolve(observed.kind === "sent_or_unknown" ? "sent" : "unsent");
      if (later && args[0] === PLUGIN) enabled.resolve();
      return observed;
    });
    const finalize = f.store.finalizeClaimedRun.bind(f.store);
    vi.spyOn(f.store, "finalizeClaimedRun").mockImplementation(async (...args) => {
      const result = await finalize(...args); finalizing.resolve(); return result;
    });
    const release = f.store.releaseUnstartedClaim.bind(f.store);
    vi.spyOn(f.store, "releaseUnstartedClaim").mockImplementation(async (...args) => {
      const result = await release(...args); decision.resolve("unsent"); return result;
    });
    const disabling = source === "shutdown" ? f.loader.shutdownAll() : lifecycle.disable(PLUGIN);
    const checkpoint = await bounded(Promise.race([registered.promise.then(() => "registered" as const), disabling.then(() => "disabled" as const)]));
    if (checkpoint === "disabled") {
      await expect(f.scheduler.triggerJob(JOB)).rejects.toThrow();
      expect(f.scheduler.registerPlugin).not.toHaveBeenCalled();
    } else {
      await bounded(lookup.promise); await pending(disabling);
      const result = await f.scheduler.triggerJob(JOB).catch((error: unknown) => error);
      if (!(result instanceof Error)) {
        const outcome = await bounded(decision.promise);
        if (outcome === "sent") { f.manager.getWorker(PLUGIN)!.notify("fixture.release", { runId: result.runId }); await bounded(finalizing.promise); }
        expect(outcome).toBe("unsent");
      }
    }
    lookupGate.resolve(); await bounded(Promise.all([other, disabling, loading]));
    if (source !== "coordinator") expect(await loading).toBeInstanceOf(Error);
    if (source === "shutdown") { await expect(lifecycle.enable(PLUGIN)).rejects.toThrow(); return; }
    later = true; await lifecycle.enable(PLUGIN);
    const next = await f.scheduler.triggerJob(JOB); laterRun = next.runId; await bounded(enabled.promise);
    f.manager.getWorker(PLUGIN)!.notify("fixture.release", { runId: next.runId });
    await bounded(f.scheduler.drain(PLUGIN));
    expect(await f.store.getRunById(next.runId)).toMatchObject({ status: "succeeded" });
  });
  it.each(["unregister", "drain", "stop"] as const)("propagates %s errors without cleanup or a lifecycle transition", async (failure) => {
    const f = fakeRuntime(); const error = new Error(`${failure} failed`);
    if (failure === "unregister") f.scheduler.unregisterPlugin.mockRejectedValue(error);
    if (failure === "drain") f.scheduler.drain.mockRejectedValue(error);
    if (failure === "stop") f.manager.stopWorker.mockRejectedValue(error);
    const loader = pluginLoader(db, {}, f.runtime);
    const lifecycle = pluginLifecycleManager(db, { loader, workerManager: f.manager as never });
    const events = vi.fn();
    lifecycle.on("plugin.status_changed", events); lifecycle.on("plugin.disabled", events); lifecycle.on("plugin.unloaded", events);
    await expect(lifecycle.disable(PLUGIN)).rejects.toBe(error);
    await expect(lifecycle.unload(PLUGIN)).rejects.toBe(error);
    expect((await db.select().from(plugins).where(eq(plugins.id, PLUGIN)))[0]?.status).toBe("ready");
    expect(events).not.toHaveBeenCalled(); expect(f.clearPlugin).not.toHaveBeenCalled();
    expect(f.unregisterPluginTools).not.toHaveBeenCalled(); expect(loader.getRuntimeGeneration(PLUGIN)).not.toBeNull();
  });
  it("stops a registered worker even when it is not yet running", async () => {
    const f = fakeRuntime();
    await pluginLoader(db, {}, f.runtime).unloadSingle(PLUGIN, KEY);
    expect(f.manager.stopWorker).toHaveBeenCalledWith(PLUGIN);
    expect(f.scheduler.drain).toHaveBeenCalledWith(PLUGIN);
  });
  it.each([["ready", []], ["upgrade_pending", ["new.cap"]]] as const)("preserves upgrade to %s", async (status, capabilities) => {
    const f = fakeRuntime(); const loader = pluginLoader(db, {}, f.runtime); const oldManifest = { capabilities: [] };
    vi.spyOn(loader, "upgradePlugin").mockResolvedValue({ oldManifest, newManifest: { capabilities }, discovered: { version: "2" } } as never);
    const load = vi.spyOn(loader, "loadSingle").mockResolvedValue({ success: true } as never);
    const lifecycle = pluginLifecycleManager(db, { loader, workerManager: f.manager as never }); expect((await lifecycle.upgrade(PLUGIN)).status).toBe(status); expect(load).toHaveBeenCalledTimes(status === "ready" ? 1 : 0);
  });
  it("keeps activation closed until the disabling lifecycle operation finishes", async () => {
    const f = fakeRuntime(); const stopped = barrier(); const hold = gate(); const loader = pluginLoader(db, {}, f.runtime);
    await db.update(plugins).set({ manifestJson: { entrypoints: { worker: entrypointPath } } as never }).where(eq(plugins.id, PLUGIN));
    const start = vi.fn().mockResolvedValue(undefined); Object.assign(f.manager, { startWorker: start });
    Object.assign(f.runtime.eventBus, { forPlugin: vi.fn(), subscriptionCount: () => 0 }); f.runtime.buildHostHandlers = () => ({});
    const unload = loader.unloadSingle.bind(loader); vi.spyOn(loader, "unloadSingle").mockImplementation(async (...args) => { await unload(...args); stopped.resolve(); await hold.promise; });
    const lifecycle = pluginLifecycleManager(db, { loader, workerManager: f.manager as never }); const disabling = lifecycle.disable(PLUGIN);
    try { await bounded(stopped.promise); const attempted = await loader.loadSingle(PLUGIN).catch((error: unknown) => error); expect(start).not.toHaveBeenCalled(); expect(attempted).toBeInstanceOf(Error); }
    finally { hold.resolve(); await bounded(disabling); }
  });
  it("stops and drains the scheduler, then drains jobs before stopping all workers", async () => {
    const f = fakeRuntime(); const schedulerGate = gate(); const jobsGate = gate(); const order: string[] = [];
    f.scheduler.stop.mockImplementation(() => { order.push("stop scheduler"); });
    f.scheduler.drain.mockImplementation(async () => { order.push("drain scheduler"); await schedulerGate.promise; });
    f.manager.drainJobs.mockImplementation(async () => { order.push("drain jobs"); await jobsGate.promise; });
    f.manager.stopAll.mockImplementation(async () => { order.push("stop all"); });
    const loader = pluginLoader(db, {}, f.runtime); const shutdown = loader.shutdownAll();
    expect(order).toEqual(["stop scheduler", "drain scheduler"]); await pending(shutdown);
    await expect(loader.loadSingle(PLUGIN)).rejects.toThrow(); await expect(loader.loadAll()).rejects.toThrow();
    schedulerGate.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["stop scheduler", "drain scheduler", "drain jobs"]); await pending(shutdown);
    jobsGate.resolve(); await bounded(shutdown); await expect(loader.loadSingle(PLUGIN)).rejects.toThrow(); await expect(loader.loadAll()).rejects.toThrow();
    expect(order).toEqual(["stop scheduler", "drain scheduler", "drain jobs", "stop all"]);
  });
  it.each(["scheduler", "jobs", "stop"] as const)("propagates global %s errors", async (failure) => {
    const f = fakeRuntime(); const error = new Error(`${failure} failed`);
    if (failure === "scheduler") f.scheduler.drain.mockRejectedValue(error);
    if (failure === "jobs") f.manager.drainJobs.mockRejectedValue(error);
    if (failure === "stop") f.manager.stopAll.mockRejectedValue(error);
    await expect(pluginLoader(db, {}, f.runtime).shutdownAll()).rejects.toBe(error);
    if (failure !== "stop") expect(f.manager.stopAll).not.toHaveBeenCalled();
    expect(f.clearPlugin).not.toHaveBeenCalled(); expect(f.unregisterPluginTools).not.toHaveBeenCalled();
  });
  it("propagates fallback stop errors without lifecycle events or status changes", async () => {
    const f = fakeRuntime(); const error = new Error("stop failed"); f.manager.stopWorker.mockRejectedValue(error);
    const lifecycle = pluginLifecycleManager(db, { loader: pluginLoader(db), workerManager: f.manager as never });
    const events = vi.fn(); lifecycle.on("plugin.worker_stopped", events); lifecycle.on("plugin.status_changed", events);
    await expect(lifecycle.disable(PLUGIN)).rejects.toBe(error);
    expect((await db.select().from(plugins).where(eq(plugins.id, PLUGIN)))[0]?.status).toBe("ready");
    expect(events).not.toHaveBeenCalled();
  });
  it("emits fallback worker_stopped only after successful stop and tolerates an absent manager", async () => {
    const f = fakeRuntime(); const stopping = gate(); f.manager.stopWorker.mockReturnValue(stopping.promise);
    const lifecycle = pluginLifecycleManager(db, { loader: pluginLoader(db), workerManager: f.manager as never });
    const events = vi.fn(); lifecycle.on("plugin.worker_stopped", events);
    const promise = lifecycle.stopWorker(PLUGIN); await pending(promise); expect(events).not.toHaveBeenCalled();
    stopping.resolve(); await bounded(promise); expect(events).toHaveBeenCalledWith({ pluginId: PLUGIN, pluginKey: KEY });
    await expect(pluginLifecycleManager(db, { loader: pluginLoader(db) }).stopWorker(PLUGIN)).resolves.toBeUndefined();
  });
});
