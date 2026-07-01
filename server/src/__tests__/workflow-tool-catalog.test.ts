import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  pluginEntities,
  plugins,
  toolDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listWorkflowToolCatalog } from "../services/workflow/tool-catalog.js";
import {
  assertWorkflowToolReferencesSelectable,
  grantWorkflowToolToAgent,
  revokeWorkflowToolFromAgent,
  syncToolRegistryToolsToCore,
} from "../services/workflow/tool-catalog.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow tool catalog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow tool catalog", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-tool-catalog-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentToolGrants);
    await db.delete(toolDefinitions);
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns core agent tool grants by agent name and tool name", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const toolId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Grant Company",
      issuePrefix: "TG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Doraemon",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-evening",
      description: "Collect evening data",
      adapterType: "plugin",
      adapterConfig: {},
    });
    await db.insert(agentToolGrants).values({
      companyId,
      agentId,
      toolId,
      grantedBy: "board",
    });

    const catalog = await listWorkflowToolCatalog(db, companyId);

    expect(catalog.tools).toEqual([
      expect.objectContaining({
        name: "collect-evening",
        source: "core",
        enabled: true,
      }),
    ]);
    expect(catalog.grants).toEqual([
      { agentName: "Doraemon", toolName: "collect-evening", source: "core" },
    ]);
    expect(catalog.sources.core).toEqual({
      available: true,
      count: 1,
      grantCount: 1,
    });
    expect(catalog.sources.toolRegistry).toEqual({
      available: false,
      installed: false,
      count: 0,
      pluginId: undefined,
      status: undefined,
      unavailableReason: "Tool Registry plugin is not installed.",
    });
  });

  it("keeps synced core tools active when the Tool Registry plugin is not ready", async () => {
    const companyId = randomUUID();
    const toolId = randomUUID();
    const pluginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Inactive Tool Company",
      issuePrefix: "ITC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.tool-registry",
      packageName: "@paperclipai/plugin-tool-registry",
      version: "1.0.0",
      manifestJson: {
        id: "insightflo.tool-registry",
        name: "Tool Registry",
        version: "1.0.0",
        apiVersion: 1,
        description: "Tool Registry",
        capabilities: [],
        entrypoints: {},
      },
      status: "error",
    });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-evening",
      description: "Collect evening data",
      adapterType: "builtin",
      adapterConfig: { source: "tool-registry" },
      enabled: true,
    });

    const catalog = await listWorkflowToolCatalog(db, companyId);

    expect(catalog.tools).toEqual([
      expect.objectContaining({
        name: "collect-evening",
        source: "core",
        enabled: true,
      }),
    ]);
    expect(catalog.sources.core.available).toBe(true);
    expect(catalog.sources.toolRegistry).toEqual({
      available: false,
      installed: true,
      status: "error",
      pluginId,
      count: 0,
      unavailableReason: "Tool Registry plugin is not ready (current status: error).",
    });
  });

  it("grants and revokes a core workflow tool by agent id and tool name", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const toolId = randomUUID();
    const otherToolId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Grant Company",
        issuePrefix: "GC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Grant Company",
        issuePrefix: "OGC",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Operator",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(toolDefinitions).values([
      {
        id: toolId,
        companyId,
        name: "core-report",
        description: "Create a report",
        adapterType: "http",
        adapterConfig: {},
      },
      {
        id: otherToolId,
        companyId: otherCompanyId,
        name: "core-report",
        description: "Other company report",
        adapterType: "http",
        adapterConfig: {},
      },
    ]);

    const granted = await grantWorkflowToolToAgent(db, {
      companyId,
      agentId,
      toolName: "core-report",
      grantedBy: "board",
    });
    const grantedAgain = await grantWorkflowToolToAgent(db, {
      companyId,
      agentId,
      toolName: "core-report",
      grantedBy: "board",
    });

    expect(granted).toEqual({ agentName: "Tool Operator", toolName: "core-report", source: "core" });
    expect(grantedAgain).toEqual(granted);
    expect((await listWorkflowToolCatalog(db, companyId)).grants).toEqual([
      { agentName: "Tool Operator", toolName: "core-report", source: "core" },
    ]);

    const revoked = await revokeWorkflowToolFromAgent(db, {
      companyId,
      agentId,
      toolName: "core-report",
    });

    expect(revoked).toBe(true);
    expect((await listWorkflowToolCatalog(db, companyId)).grants).toEqual([]);
  });

  it("syncs tool-registry tools and grants into core catalog records", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Registry Sync Company",
      issuePrefix: "RSC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Doraemon",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.tool-registry",
      packageName: "@paperclipai/plugin-tool-registry",
      version: "1.0.0",
      manifestJson: {
        id: "insightflo.tool-registry",
        name: "Tool Registry",
        version: "1.0.0",
        apiVersion: 1,
        description: "Tool Registry",
        capabilities: [],
        entrypoints: {},
      },
      status: "ready",
    });
    await db.insert(pluginEntities).values([
      {
        pluginId,
        entityType: "tool-config",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${companyId}::collect-evening`,
        title: "collect-evening",
        status: "active",
        data: {
          name: "collect-evening",
          command: "pnpm collect evening",
          description: "Collect evening inputs",
          requiresApproval: true,
          argsSchema: { type: "object", properties: { date: { type: "string" } } },
        },
      },
      {
        pluginId,
        entityType: "agent-tool-grant",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${companyId}::Doraemon::collect-evening`,
        title: "Doraemon -> collect-evening",
        status: "active",
        data: {
          agentName: "Doraemon",
          toolName: "collect-evening",
          grantedBy: "operator",
        },
      },
    ]);

    const result = await syncToolRegistryToolsToCore(db, companyId);
    const catalog = await listWorkflowToolCatalog(db, companyId);
    const [coreTool] = await db.select().from(toolDefinitions);

    expect(result).toEqual({ createdTools: 1, updatedTools: 0, createdGrants: 1, skippedGrants: 0 });
    expect(coreTool).toEqual(expect.objectContaining({
      companyId,
      name: "collect-evening",
      description: "Collect evening inputs",
      inputSchema: { type: "object", properties: { date: { type: "string" } } },
      adapterType: "builtin",
      adapterConfig: expect.objectContaining({
        source: "tool-registry",
        command: "pnpm collect evening",
        requiresApproval: true,
      }),
    }));
    expect(catalog.sources.core).toEqual({ available: true, count: 1, grantCount: 1 });
    expect(catalog.tools.find((tool) => tool.name === "collect-evening")).toEqual(expect.objectContaining({
      source: "core",
      enabled: true,
    }));
    expect(catalog.grants).toEqual([
      { agentName: "Doraemon", toolName: "collect-evening", source: "core" },
    ]);
  });

  it("exposes Research Workbench search as a default workflow agent tool", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const researchPluginId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Research Tool Company",
      issuePrefix: "RTC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: researchPluginId,
      pluginKey: "insightflo.research-workbench",
      packageName: "@insightflo/paperclip-research-workbench",
      version: "0.1.0",
      manifestJson: {
        id: "insightflo.research-workbench",
        displayName: "Research Workbench",
        version: "0.1.0",
        apiVersion: 1,
        description: "Research Workbench",
        capabilities: ["agent.tools.register"],
        entrypoints: { worker: "./dist/worker.js" },
        tools: [
          {
            name: "research-search",
            displayName: "Research Search",
            description: "Search the web and return structured evidence bundles.",
            parametersSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                maxResults: { type: "number" },
              },
              required: ["query"],
            },
          },
        ],
      },
      status: "ready",
    });

    const catalog = await listWorkflowToolCatalog(db, companyId);

    expect(catalog.tools).toContainEqual(expect.objectContaining({
      name: "insightflo.research-workbench:research-search",
      displayName: "Research Search",
      source: "plugin",
      enabled: true,
      pluginId: researchPluginId,
    }));
    expect(catalog.grants).toContainEqual({
      agentName: "Research Agent",
      toolName: "insightflo.research-workbench:research-search",
      source: "plugin",
    });
    await expect(assertWorkflowToolReferencesSelectable(db, {
      companyId,
      steps: [
        {
          id: "collect-sources",
          name: "Collect sources",
          type: "agent",
          agentName: "Research Agent",
          toolNames: ["insightflo.research-workbench:research-search"],
        },
      ],
    })).resolves.toBeUndefined();
  });
});
