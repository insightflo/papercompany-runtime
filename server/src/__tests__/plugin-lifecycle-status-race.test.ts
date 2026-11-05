import { createDb, plugins, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";

const TARGET = "0ef2c8ae-605d-47d0-867a-571181022001";
const OTHER = "0ef2c8ae-605d-47d0-867a-571181022002";
const KEY = "fixture.lifecycle-race";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Delay the real SQL UPDATE at its execution boundary, not its returned rows.
function delayNextReadyUpdate(db: Db, entered: ReturnType<typeof barrier>, release: ReturnType<typeof barrier>): Db {
  let armed = true;
  return new Proxy(db, {
    get(target, property) {
      if (property !== "update") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (table: Parameters<Db["update"]>[0]) => {
        const builder = target.update(table);
        return {
          set(values: Parameters<typeof builder.set>[0]) {
            const statement = builder.set(values);
            if (!armed || !("status" in values) || values.status !== "ready") return statement;
            armed = false;
            return {
              where(predicate: Parameters<typeof statement.where>[0]) {
                const query = statement.where(predicate);
                return {
                  async returning() {
                    entered.resolve();
                    await release.promise;
                    return query.returning();
                  },
                };
              },
            };
          },
        };
      };
    },
  }) as Db;
}

function runtime() {
  return {
    jobScheduler: { unregisterPlugin: vi.fn().mockResolvedValue(undefined), drain: vi.fn().mockResolvedValue(undefined) },
    workerManager: { stopWorker: vi.fn().mockResolvedValue(undefined) },
    eventBus: { clearPlugin: vi.fn() },
    toolDispatcher: { unregisterPluginTools: vi.fn() },
    instanceInfo: { hostVersion: "1" },
  } as unknown as PluginRuntimeServices;
}

describe("plugin lifecycle status and teardown ordering", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const releases: Array<() => void> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-lifecycle-status-race-");
    db = createDb(tempDb.connectionString);
    await db.insert(plugins).values([
      { id: TARGET, pluginKey: KEY, packageName: "@fixture/race", version: "1", status: "disabled", manifestJson: {} as never },
      { id: OTHER, pluginKey: "fixture.other-race", packageName: "@fixture/other", version: "1", status: "disabled", manifestJson: {} as never },
    ]);
  }, 120_000);
  beforeEach(async () => {
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, OTHER));
  });
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb.cleanup(); });

  it.each([
    ["enable", "disabled"],
    ["load", "installed"],
    ["upgrade", "ready"],
  ] as const)("orders a held %s status write before unload without blocking another plugin", async (operation, status) => {
    await db.update(plugins).set({ status }).where(eq(plugins.id, TARGET));
    const entered = barrier();
    const release = barrier();
    releases.push(release.resolve);
    const wrapped = delayNextReadyUpdate(db, entered, release);
    const services = runtime();
    const loader = pluginLoader(wrapped, {}, services);
    vi.spyOn(loader, "cleanupInstallArtifacts").mockResolvedValue(undefined);
    vi.spyOn(loader, "loadSingle").mockResolvedValue({ success: true } as never);
    vi.spyOn(loader, "upgradePlugin").mockResolvedValue({
      oldManifest: { version: "1", capabilities: [] },
      newManifest: { version: "2", capabilities: [] },
      discovered: { version: "2" },
    } as never);
    const lifecycle = pluginLifecycleManager(wrapped, { loader });
    const events: Array<{ pluginId: string; status: string }> = [];
    lifecycle.on("plugin.status_changed", ({ pluginId, newStatus }) => events.push({ pluginId, status: newStatus }));
    const activation = lifecycle[operation](TARGET).catch((error: unknown) => error);
    await entered.promise;
    const removing = lifecycle.unload(TARGET);
    const completedEarly = await Promise.race([
      removing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    const closedDuringWrite = loader.getRuntimeGeneration(TARGET) === null;
    const unregisteredDuringWrite = vi.mocked(services.jobScheduler.unregisterPlugin).mock.calls.length > 0;
    await lifecycle.enable(OTHER);
    release.resolve();
    await activation;
    await removing;
    const [target] = await db.select().from(plugins).where(eq(plugins.id, TARGET));
    const [other] = await db.select().from(plugins).where(eq(plugins.id, OTHER));
    const targetEvents = events.filter((event) => event.pluginId === TARGET).map((event) => event.status);
    expect(completedEarly).toBe(false);
    expect(closedDuringWrite).toBe(true);
    expect(unregisteredDuringWrite).toBe(true);
    expect(target?.status).toBe("uninstalled");
    expect(targetEvents.at(-1)).toBe("uninstalled");
    expect(other?.status).toBe("ready");
  });

  it("closes admission during a held load, then permits a later enable", async () => {
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, TARGET));
    const entered = barrier();
    const release = barrier();
    releases.push(release.resolve);
    const wrapped = delayNextReadyUpdate(db, entered, release);
    const services = runtime();
    const loader = pluginLoader(wrapped, {}, services);
    vi.spyOn(loader, "loadSingle").mockResolvedValue({ success: true } as never);
    const lifecycle = pluginLifecycleManager(wrapped, { loader });
    const statuses: string[] = [];
    const enabled = vi.fn();
    lifecycle.on("plugin.status_changed", ({ newStatus }) => statuses.push(newStatus));
    lifecycle.on("plugin.enabled", enabled);
    const loading = lifecycle.load(TARGET).catch((error: unknown) => error);
    await entered.promise;
    const disabling = lifecycle.disable(TARGET);
    const completedEarly = await Promise.race([
      disabling.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    const closedDuringWrite = loader.getRuntimeGeneration(TARGET) === null;
    const unregisteredDuringWrite = vi.mocked(services.jobScheduler.unregisterPlugin).mock.calls.length > 0;
    release.resolve();
    expect(await loading).toBeInstanceOf(Error);
    await disabling;
    const [disabled] = await db.select().from(plugins).where(eq(plugins.id, TARGET));
    expect(completedEarly).toBe(false);
    expect(closedDuringWrite).toBe(true);
    expect(unregisteredDuringWrite).toBe(true);
    expect(disabled?.status).toBe("disabled");
    expect(statuses).toEqual(["ready", "disabled"]);
    expect(enabled).not.toHaveBeenCalled();
    await lifecycle.enable(TARGET);
    expect((await db.select().from(plugins).where(eq(plugins.id, TARGET)))[0]?.status).toBe("ready");
    expect(enabled).toHaveBeenCalledTimes(1);
  });

  it("allows a later disable after teardown fails", async () => {
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, TARGET));
    const services = runtime();
    vi.mocked(services.jobScheduler.unregisterPlugin).mockRejectedValueOnce(new Error("unregister failed"));
    const loader = pluginLoader(db, {}, services);
    const lifecycle = pluginLifecycleManager(db, { loader });
    const statuses: string[] = [];
    lifecycle.on("plugin.status_changed", ({ newStatus }) => statuses.push(newStatus));
    await expect(lifecycle.disable(TARGET)).rejects.toThrow("unregister failed");
    expect((await db.select().from(plugins).where(eq(plugins.id, TARGET)))[0]?.status).toBe("ready");
    expect(statuses).toEqual([]);
    await expect(lifecycle.disable(TARGET)).resolves.toMatchObject({ status: "disabled" });
    expect(statuses).toEqual(["disabled"]);
  });

  it("does not emit duplicate uninstall transitions for concurrent unloads", async () => {
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, TARGET));
    const entered = barrier();
    const release = barrier();
    const bothUnregistered = barrier();
    releases.push(release.resolve);
    const services = runtime();
    let unregisterCount = 0;
    vi.mocked(services.jobScheduler.unregisterPlugin).mockImplementation(async () => {
      if (++unregisterCount === 2) bothUnregistered.resolve();
    });
    const loader = pluginLoader(db, {}, services);
    vi.spyOn(loader, "cleanupInstallArtifacts").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const lifecycle = pluginLifecycleManager(db, { loader });
    const statuses: string[] = [];
    lifecycle.on("plugin.status_changed", ({ newStatus }) => statuses.push(newStatus));
    const first = lifecycle.unload(TARGET);
    await entered.promise;
    const second = lifecycle.unload(TARGET).catch((error: unknown) => error);
    await bothUnregistered.promise;
    release.resolve();
    await first;
    expect(await second).toBeInstanceOf(Error);
    expect(statuses).toEqual(["uninstalled"]);
  });

  it("can mark an upgrade activation failure without a nested status-lock deadlock", async () => {
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, TARGET));
    const loader = pluginLoader(db, {}, runtime());
    vi.spyOn(loader, "upgradePlugin").mockResolvedValue({
      oldManifest: { version: "1", capabilities: [] },
      newManifest: { version: "2", capabilities: [] },
      discovered: { version: "2" },
    } as never);
    const lifecycle = pluginLifecycleManager(db, { loader });
    vi.spyOn(loader, "loadSingle").mockImplementation(async () => {
      await lifecycle.markError(TARGET, "activation failed");
      return { success: false, error: "activation failed" } as never;
    });
    await expect(lifecycle.upgrade(TARGET)).rejects.toThrow("activation failed");
    expect((await db.select().from(plugins).where(eq(plugins.id, TARGET)))[0]?.status).toBe("error");
  });
});
