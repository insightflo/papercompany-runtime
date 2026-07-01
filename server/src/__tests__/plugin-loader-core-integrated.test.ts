import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";

const mockRegistry = vi.hoisted(() => ({
  listByStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

function manifest(pluginKey: string): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: pluginKey,
    description: "Test plugin",
    author: "papercompany",
    categories: [],
    capabilities: [],
    entrypoints: {
      worker: "dist/worker.js",
    },
  };
}

function pluginRecord(pluginKey: string): PluginRecord {
  return {
    id: `${pluginKey}-plugin-id`,
    pluginKey,
    packageName: `@test/${pluginKey}`,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: manifest(pluginKey),
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
  };
}

function runtimeServices() {
  const startWorker = vi.fn();
  const services = {
    workerManager: {
      startWorker,
    },
    eventBus: {
      forPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    },
    jobScheduler: {
      registerPlugin: vi.fn(),
    },
    jobStore: {
      syncJobDeclarations: vi.fn(),
    },
    toolDispatcher: {
      registerPluginTools: vi.fn(),
    },
    lifecycleManager: {
      markError: vi.fn(),
      load: vi.fn(),
    },
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: {
      instanceId: "test-instance",
      hostVersion: "0.0.0",
    },
  } as unknown as PluginRuntimeServices;

  return { services, startWorker };
}

describe("pluginLoader core-integrated plugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips Tool Registry runtime activation because it is core-integrated", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      pluginRecord("insightflo.tool-registry"),
    ]);
    const { services, startWorker } = runtimeServices();
    const { pluginLoader } = await import("../services/plugin-loader.js");

    const result = await pluginLoader(
      {} as never,
      { enableLocalFilesystem: false, enableNpmDiscovery: false },
      services,
    ).loadAll();

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.registered).toEqual({
      worker: false,
      eventSubscriptions: 0,
      jobs: 0,
      webhooks: 0,
      tools: 0,
    });
    expect(startWorker).not.toHaveBeenCalled();
  });
});
