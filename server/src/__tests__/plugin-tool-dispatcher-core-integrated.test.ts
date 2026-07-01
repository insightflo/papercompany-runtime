import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
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

function manifest(pluginKey: string, toolName = "mark-done"): PaperclipPluginManifestV1 {
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
    tools: [
      {
        name: toolName,
        displayName: toolName,
        description: `Run ${toolName}`,
        parametersSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
}

function pluginRecord(pluginKey: string, toolName?: string): PluginRecord {
  return {
    id: `${pluginKey}-plugin-id`,
    pluginKey,
    packageName: `@test/${pluginKey}`,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: manifest(pluginKey, toolName),
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-06-30T00:00:00.000Z"),
    updatedAt: new Date("2026-06-30T00:00:00.000Z"),
  };
}

describe("PluginToolDispatcher core-integrated plugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not register Tool Registry tools from ready plugin DB rows", async () => {
    mockRegistry.listByStatus.mockResolvedValue([
      pluginRecord("insightflo.tool-registry"),
      pluginRecord("insightflo.research-workbench", "research-search"),
    ]);
    const { createPluginToolDispatcher } = await import("../services/plugin-tool-dispatcher.js");

    const dispatcher = createPluginToolDispatcher({ db: {} as never });
    await dispatcher.initialize();

    expect(dispatcher.toolCount("insightflo.tool-registry")).toBe(0);
    expect(dispatcher.getTool("insightflo.tool-registry:mark-done")).toBeNull();
    expect(dispatcher.toolCount("insightflo.research-workbench")).toBe(1);
    expect(dispatcher.getTool("insightflo.research-workbench:research-search")).not.toBeNull();
    expect(dispatcher.listToolsForAgent().map((tool) => tool.name)).toEqual([
      "insightflo.research-workbench:research-search",
    ]);
  });

  it("does not register Tool Registry tools from manual dispatcher registration", async () => {
    const { createPluginToolDispatcher } = await import("../services/plugin-tool-dispatcher.js");

    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools(
      "insightflo.tool-registry",
      manifest("insightflo.tool-registry"),
      "tool-registry-plugin-id",
    );
    dispatcher.registerPluginTools(
      "insightflo.research-workbench",
      manifest("insightflo.research-workbench", "research-search"),
      "research-workbench-plugin-id",
    );

    expect(dispatcher.toolCount("insightflo.tool-registry")).toBe(0);
    expect(dispatcher.getTool("insightflo.tool-registry:mark-done")).toBeNull();
    expect(dispatcher.toolCount("insightflo.research-workbench")).toBe(1);
  });
});
