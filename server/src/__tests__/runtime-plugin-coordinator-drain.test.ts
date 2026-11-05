import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginJobCoordinator } from "../services/plugin-job-coordinator.js";

const mockRegistry = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));

const PLUGIN_ID = "plugin-id";
const PLUGIN_KEY = "fixture.plugin";
const loaded = { pluginId: PLUGIN_ID, pluginKey: PLUGIN_KEY };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
}

function fixture() {
  mockRegistry.getById.mockResolvedValue({ manifestJson: { jobs: [{ jobKey: "refresh" }] } });
  const lifecycle = Object.assign(new EventEmitter(), { getRuntimeGeneration: vi.fn(() => 1) });
  const scheduler = {
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    unregisterPlugin: vi.fn().mockResolvedValue(undefined),
  };
  const jobStore = {
    syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
    deleteAllJobs: vi.fn().mockResolvedValue(undefined),
  };
  const coordinator = createPluginJobCoordinator({ db: {} as never, lifecycle: lifecycle as never,
    scheduler: scheduler as never, jobStore: jobStore as never });
  coordinator.start();
  return { lifecycle, scheduler, jobStore, coordinator };
}

function emitAfterStop(f: ReturnType<typeof fixture>) {
  f.coordinator.start();
  f.lifecycle.emit("plugin.loaded", loaded);
  f.lifecycle.emit("plugin.disabled", { ...loaded, reason: "test" });
  f.lifecycle.emit("plugin.unloaded", { ...loaded, removeData: true });
}

describe("plugin job coordinator operation drain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("joins an admitted load through registry, DB sync, and scheduler registration", async () => {
    const f = fixture();
    const lookup = deferred<{ manifestJson: { jobs: { jobKey: string }[] } }>();
    const syncEntered = deferred<void>(), syncRelease = deferred<void>();
    const registerEntered = deferred<void>(), registerRelease = deferred<void>();
    mockRegistry.getById.mockReturnValue(lookup.promise);
    f.jobStore.syncJobDeclarations.mockImplementation(async () => {
      syncEntered.resolve(undefined); await syncRelease.promise;
    });
    f.scheduler.registerPlugin.mockImplementation(async () => {
      registerEntered.resolve(undefined); await registerRelease.promise;
    });
    f.lifecycle.emit("plugin.loaded", loaded);
    f.coordinator.stop();
    const draining = f.coordinator.drain();
    try {
      await expectPending(draining);
      expect(mockRegistry.getById).toHaveBeenCalledTimes(1);
      lookup.resolve({ manifestJson: { jobs: [{ jobKey: "refresh" }] } });
      await syncEntered.promise;
      await expectPending(draining);
      expect(f.scheduler.registerPlugin).not.toHaveBeenCalled();
      syncRelease.resolve(undefined);
      await registerEntered.promise;
      await expectPending(draining);
      emitAfterStop(f);
      expect(mockRegistry.getById).toHaveBeenCalledTimes(1);
      expect(f.jobStore.syncJobDeclarations).toHaveBeenCalledTimes(1);
      expect(f.scheduler.registerPlugin).toHaveBeenCalledTimes(1);
      expect(f.scheduler.unregisterPlugin).not.toHaveBeenCalled();
      registerRelease.resolve(undefined);
      await draining;
    } finally {
      lookup.resolve({ manifestJson: { jobs: [{ jobKey: "refresh" }] } });
      syncRelease.resolve(undefined); registerRelease.resolve(undefined);
      f.coordinator.stop(); await f.coordinator.drain();
    }
  });

  it("joins an admitted disable through scheduler unregistration", async () => {
    const f = fixture(); const entered = deferred<void>(), release = deferred<void>();
    f.scheduler.unregisterPlugin.mockImplementation(async () => { entered.resolve(undefined); await release.promise; });
    f.lifecycle.emit("plugin.disabled", { ...loaded, reason: "operator" });
    f.coordinator.stop(); const draining = f.coordinator.drain();
    try {
      await entered.promise; await expectPending(draining); emitAfterStop(f);
      expect(f.scheduler.unregisterPlugin).toHaveBeenCalledTimes(1);
      expect(mockRegistry.getById).not.toHaveBeenCalled();
      release.resolve(undefined); await draining;
      expect(f.jobStore.deleteAllJobs).not.toHaveBeenCalled();
    } finally { release.resolve(undefined); f.coordinator.stop(); await f.coordinator.drain(); }
  });

  it("joins unload purge after unregister and admits no post-stop lifecycle work", async () => {
    const f = fixture(); const unregisterEntered = deferred<void>(), unregisterRelease = deferred<void>();
    const purgeEntered = deferred<void>(), purgeRelease = deferred<void>();
    f.scheduler.unregisterPlugin.mockImplementation(async () => {
      unregisterEntered.resolve(undefined); await unregisterRelease.promise;
    });
    f.jobStore.deleteAllJobs.mockImplementation(async () => { purgeEntered.resolve(undefined); await purgeRelease.promise; });
    f.lifecycle.emit("plugin.unloaded", { ...loaded, removeData: true });
    f.coordinator.stop(); const draining = f.coordinator.drain();
    try {
      await unregisterEntered.promise; await expectPending(draining);
      unregisterRelease.resolve(undefined); await purgeEntered.promise; await expectPending(draining);
      emitAfterStop(f);
      expect(f.scheduler.unregisterPlugin).toHaveBeenCalledTimes(1);
      expect(f.jobStore.deleteAllJobs).toHaveBeenCalledTimes(1);
      expect(f.jobStore.deleteAllJobs).toHaveBeenCalledWith(PLUGIN_ID);
      purgeRelease.resolve(undefined); await draining;
    } finally {
      unregisterRelease.resolve(undefined); purgeRelease.resolve(undefined);
      f.coordinator.stop(); await f.coordinator.drain();
    }
  });
});
