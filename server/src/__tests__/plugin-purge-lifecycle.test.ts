import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createDb, pluginJobRuns, pluginJobs, pluginWebhookDeliveries, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

const workerPath = fileURLToPath(new URL("./fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
}

describe("plugin purge lifecycle ordering", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let tempRoot: string;
  let packageRoot: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-purge-lifecycle-");
    db = createDb(database.connectionString);
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-purge-lifecycle-"));
    packageRoot = path.join(tempRoot, "plugins");
    await mkdir(packageRoot);
  }, 120_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await database.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function seed(status: "ready" | "uninstalled" = "ready") {
    const id = randomUUID(), packageName = `@fixture/purge-${id}`;
    const packageDir = path.join(packageRoot, packageName), marker = path.join(packageDir, "package.marker");
    await mkdir(packageDir, { recursive: true });
    await writeFile(marker, "installed package");
    const [plugin] = await db.insert(plugins).values({
      id, pluginKey: `fixture.purge.${id}`, packageName, version: "1", status, manifestJson: {} as never,
    }).returning();
    return { plugin: plugin!, marker };
  }
  async function seedJob(pluginId: string) {
    const [job] = await db.insert(pluginJobs).values({ pluginId, jobKey: randomUUID(), schedule: "0 * * * *" }).returning();
    return job!;
  }
  async function lifecycle(pluginDir = packageRoot) {
    const loader = pluginLoader(db, { localPluginDir: pluginDir });
    return { loader, manager: pluginLifecycleManager(db, { loader }) };
  }

  it("rejects before package cleanup and retains plugin, job, run, receipt, and success events", async () => {
    const f = await seed("uninstalled"), job = await seedJob(f.plugin.id);
    const [run] = await db.insert(pluginJobRuns).values({ jobId: job.id, pluginId: f.plugin.id, trigger: "manual", status: "queued" }).returning();
    const [receipt] = await db.insert(pluginWebhookDeliveries).values({
      pluginId: f.plugin.id, webhookKey: randomUUID(), status: "pending", payload: {},
    }).returning();
    const { loader, manager } = await lifecycle();
    const cleanup = vi.spyOn(loader, "cleanupInstallArtifacts");
    const statusEvent = vi.fn(), unloadedEvent = vi.fn();
    manager.on("plugin.status_changed", statusEvent); manager.on("plugin.unloaded", unloadedEvent);

    await expect(manager.unload(f.plugin.id, true)).rejects.toMatchObject({ code: "PLUGIN_PURGE_CONFLICT" });

    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(f.marker)).toBe(true);
    expect(await db.select().from(plugins).where(eq(plugins.id, f.plugin.id))).toHaveLength(1);
    expect(await db.select().from(pluginJobs).where(eq(pluginJobs.id, job.id))).toHaveLength(1);
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, run!.id))).toHaveLength(1);
    expect(await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.id, receipt!.id))).toHaveLength(1);
    expect(statusEvent).not.toHaveBeenCalled(); expect(unloadedEvent).not.toHaveBeenCalled();
  });

  it.each(["already-uninstalled", "ordinary"] as const)("cleans up after registry commit in the %s hard-delete path", async (kind) => {
    const f = await seed(kind === "already-uninstalled" ? "uninstalled" : "ready");
    const { loader, manager } = await lifecycle();
    const original = loader.cleanupInstallArtifacts.bind(loader), order: Array<string | null> = [];
    vi.spyOn(loader, "cleanupInstallArtifacts").mockImplementation(async (plugin) => {
      order.push((await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, plugin.id)))[0]?.id ?? null);
      await original(plugin);
    });
    const statuses: string[] = [], unloaded: boolean[] = [];
    manager.on("plugin.status_changed", ({ newStatus }) => statuses.push(newStatus));
    manager.on("plugin.unloaded", ({ removeData }) => unloaded.push(removeData));

    await manager.unload(f.plugin.id, true);

    expect(order).toEqual([null]);
    expect(existsSync(f.marker)).toBe(false);
    expect(statuses).toEqual(kind === "ordinary" ? ["uninstalled"] : []);
    expect(unloaded).toEqual([true]);
  });

  it("rechecks an already-uninstalled plugin under the status lock before hard deletion", async () => {
    const f = await seed(), { loader, manager } = await lifecycle();
    const entered = barrier(), release = barrier(), secondDeactivation = barrier();
    const original = loader.cleanupInstallArtifacts.bind(loader);
    let cleanupCalls = 0, deactivations = 0;
    const begin = loader.beginRuntimeDeactivation!.bind(loader);
    vi.spyOn(loader, "beginRuntimeDeactivation").mockImplementation((id) => {
      if (++deactivations === 2) secondDeactivation.resolve();
      return begin(id);
    });
    const order: Array<string | null> = [];
    vi.spyOn(loader, "cleanupInstallArtifacts").mockImplementation(async (plugin) => {
      if (++cleanupCalls === 1) { entered.resolve(); await release.promise; }
      order.push((await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, plugin.id)))[0]?.id ?? null);
      await original(plugin);
    });
    const statuses: string[] = [], unloaded: boolean[] = [];
    manager.on("plugin.status_changed", ({ newStatus }) => statuses.push(newStatus));
    manager.on("plugin.unloaded", ({ removeData }) => unloaded.push(removeData));

    const soft = manager.unload(f.plugin.id, false);
    await bounded(entered.promise);
    const hard = manager.unload(f.plugin.id, true);
    await bounded(secondDeactivation.promise);
    release.resolve();
    await Promise.all([soft, hard]);

    expect(order).toEqual([f.plugin.id, null]);
    expect(existsSync(f.marker)).toBe(false);
    expect(statuses).toEqual(["uninstalled"]);
    expect(unloaded).toEqual([false, true]);
  });

  it("keeps a hard purge behind the real retained-result ACK-loss retry", async () => {
    const f = await seed(), job = await seedJob(f.plugin.id), store = pluginJobStore(db);
    const workerManager = createPluginWorkerManager();
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager, jobTimeoutMs: 5_000 });
    const runtime = {
      workerManager, jobScheduler: scheduler, eventBus: { clearPlugin: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() }, instanceInfo: { instanceId: "test", hostVersion: "1" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader(db, { localPluginDir: packageRoot }, runtime);
    const manager = pluginLifecycleManager(db, { loader, workerManager });
    const started = barrier(), committed = barrier(), loseAck = barrier(), alreadyFinalized = barrier(), returnAck = barrier();
    let runId: string | undefined;
    const realFinalize = store.finalizeClaimedRun.bind(store);
    const realCleanup = loader.cleanupInstallArtifacts.bind(loader);
    vi.spyOn(store, "finalizeClaimedRun").mockImplementation(async (...args) => {
      const result = await realFinalize(...args);
      if (!runId) return result;
      if (result === "finalized") { committed.resolve(); await loseAck.promise; throw new Error("simulated lost database response"); }
      if (result === "already_finalized") { alreadyFinalized.resolve(); await returnAck.promise; }
      return result;
    });
    const cleanup = vi.spyOn(loader, "cleanupInstallArtifacts").mockImplementation(async (plugin) => {
      expect(await db.select().from(plugins).where(eq(plugins.id, plugin.id))).toHaveLength(0);
      await realCleanup(plugin);
    });
    await workerManager.startWorker(f.plugin.id, {
      entrypointPath: workerPath, manifest: {} as never, config: {}, apiVersion: 1, autoRestart: false,
      instanceInfo: { instanceId: "test", hostVersion: "1" }, hostHandlers: {},
      onStreamNotification: (_method, value) => { if (value.event === "started") { runId = String(value.runId); started.resolve(); } },
    });
    try {
      await scheduler.registerPlugin(f.plugin.id);
      const requested = await scheduler.triggerJob(job.id);
      await bounded(started.promise);
      workerManager.getWorker(f.plugin.id)!.notify("fixture.release", { runId: requested.runId });
      await bounded(committed.promise);
      expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, requested.runId))).toMatchObject([{ status: "succeeded", finishedAt: expect.any(Date) }]);

      const unloading = manager.unload(f.plugin.id, true);
      await pending(unloading);
      expect(cleanup).not.toHaveBeenCalled();
      expect(workerManager.retainedJobCount()).toBe(1);
      expect(await db.select().from(plugins).where(eq(plugins.id, f.plugin.id))).toHaveLength(1);

      loseAck.resolve();
      await bounded(alreadyFinalized.promise);
      await pending(unloading);
      expect(cleanup).not.toHaveBeenCalled();
      expect(workerManager.retainedJobCount()).toBe(1);
      returnAck.resolve();
      await bounded(unloading);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(await db.select().from(plugins).where(eq(plugins.id, f.plugin.id))).toHaveLength(0);
      expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, requested.runId))).toHaveLength(0);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      loseAck.resolve(); returnAck.resolve();
      if (runId && workerManager.isRunning(f.plugin.id)) workerManager.getWorker(f.plugin.id)!.notify("fixture.release", { runId });
      scheduler.stop(); await Promise.allSettled([scheduler.drain(), workerManager.stopAll()]);
    }
  }, 20_000);
});
