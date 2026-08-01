import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants, agents, companies, createDb, pluginEntities, plugins, toolDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  grantWorkflowToolToAgent, listWorkflowToolCatalog, syncToolRegistryToolsToCore,
} from "../services/workflow/tool-catalog.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("remote workflow tool catalog", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-remote-tool-catalog-");
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
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function seedAgent(companyName: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: companyName, issuePrefix: "RTC", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Tool Operator", role: "operator", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return { companyId, agentId };
  }

  it("exposes and grants builtin, http, and mcp definitions", async () => {
    const { companyId, agentId } = await seedAgent("Remote Tools");
    await db.insert(toolDefinitions).values([
      { companyId, name: "collect-local", adapterType: "builtin", adapterConfig: { command: "true" } },
      { companyId, name: "collect-http", adapterType: "http", adapterConfig: { url: "https://n8n.example.test/hook" } },
      { companyId, name: "collect-mcp", adapterType: "mcp", adapterConfig: { url: "https://mcp.example.test/mcp" } },
    ]);

    const catalog = await listWorkflowToolCatalog(db, companyId);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["collect-http", "collect-local", "collect-mcp"]);
    for (const toolName of ["collect-http", "collect-mcp"]) {
      await expect(grantWorkflowToolToAgent(db, { companyId, agentId, toolName, grantedBy: "board" }))
        .resolves.toMatchObject({ toolName, source: "core" });
    }
  });

  it("does not reclaim a board-managed http definition during registry sync", async () => {
    const { companyId } = await seedAgent("Detached Tool");
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "insightflo.tool-registry", packageName: "@paperclipai/plugin-tool-registry",
      version: "1.0.0", status: "ready",
      manifestJson: {
        id: "insightflo.tool-registry", name: "Tool Registry", version: "1.0.0", apiVersion: 1,
        description: "Tool Registry", capabilities: [], entrypoints: { worker: "./dist/worker.js" },
      },
    });
    await db.insert(toolDefinitions).values({
      companyId, name: "collect-evening", adapterType: "http",
      adapterConfig: { url: "https://n8n.example.test/hook", method: "POST" },
    });
    await db.insert(pluginEntities).values({
      pluginId, entityType: "tool-config", scopeKind: "company", scopeId: companyId,
      externalId: `${companyId}::collect-evening`, title: "collect-evening", status: "active",
      data: { name: "collect-evening", command: "pnpm collect", argsSchema: { type: "object" } },
    });

    const result = await syncToolRegistryToolsToCore(db, companyId);
    const [tool] = await db.select().from(toolDefinitions);
    expect(result.updatedTools).toBe(0);
    expect(tool.adapterType).toBe("http");
    expect(tool.adapterConfig).toEqual({ url: "https://n8n.example.test/hook", method: "POST" });
  });
});
