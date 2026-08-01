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
import {
  assertWorkflowToolReferencesSelectable,
  syncToolRegistryToolsToCore,
} from "../services/workflow/tool-catalog.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow tool catalog agent id tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow tool catalog agent id boundaries", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-tool-catalog-agent-id-");
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
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function createCompany(companyId = randomUUID()) {
    await db.insert(companies).values({
      id: companyId,
      name: "Agent Id Boundary Company",
      issuePrefix: "AIB",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(companyId: string, id: string, name = "Research Scout") {
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  it("does not sync a legacy registry grant when agent name is ambiguous", async () => {
    const companyId = await createCompany();
    const pluginId = randomUUID();
    await createAgent(companyId, randomUUID());
    await createAgent(companyId, randomUUID());
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
        externalId: `${companyId}::collect-sources`,
        title: "collect-sources",
        status: "active",
        data: { name: "collect-sources", command: "pnpm collect" },
      },
      {
        pluginId,
        entityType: "agent-tool-grant",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${companyId}::Research Scout::collect-sources`,
        title: "Research Scout -> collect-sources",
        status: "active",
        data: { agentName: "Research Scout", toolName: "collect-sources" },
      },
    ]);

    const result = await syncToolRegistryToolsToCore(db, companyId);
    const grants = await db.select().from(agentToolGrants);

    expect(result).toEqual({ createdTools: 1, updatedTools: 0, createdGrants: 0, skippedGrants: 1 });
    expect(grants).toEqual([]);
  });

  it("does not borrow a grant from another agent with the same display name", async () => {
    const companyId = await createCompany();
    const grantedAgentId = randomUUID();
    const ungrantedAgentId = randomUUID();
    const toolId = randomUUID();
    await createAgent(companyId, grantedAgentId);
    await createAgent(companyId, ungrantedAgentId);
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-sources",
      description: "Collect sources",
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(agentToolGrants).values({
      companyId,
      agentId: grantedAgentId,
      toolId,
      grantedBy: "board",
    });

    await expect(assertWorkflowToolReferencesSelectable(db, {
      companyId,
      steps: [{
        id: "collect",
        name: "Collect",
        type: "agent",
        agentId: ungrantedAgentId,
        agentName: "Research Scout",
        dependencies: [],
        toolNames: ["collect-sources"],
      }],
    })).rejects.toThrow('Workflow tool "collect-sources" is not granted to agent "Research Scout".');
  });

  it("accepts an agentId-only workflow tool step when the grant matches that agent", async () => {
    const companyId = await createCompany();
    const agentId = randomUUID();
    const toolId = randomUUID();
    await createAgent(companyId, agentId);
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-sources",
      description: "Collect sources",
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(agentToolGrants).values({
      companyId,
      agentId,
      toolId,
      grantedBy: "board",
    });

    await expect(assertWorkflowToolReferencesSelectable(db, {
      companyId,
      steps: [{
        id: "collect",
        name: "Collect",
        type: "agent",
        agentId,
        dependencies: [],
        toolNames: ["collect-sources"],
      }],
    })).resolves.toBeUndefined();
  });
});
