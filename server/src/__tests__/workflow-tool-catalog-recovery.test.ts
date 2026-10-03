import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, pluginEntities, plugins, toolDefinitions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { syncToolRegistryToolsToCore } from "../services/workflow/tool-catalog.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const recovery = { version: 1, sameRunRetry: "forbidden", reconcile: "operator", notes: ["late apply possible"] };

// Catches catalog sync silently dropping or overwriting declared recovery metadata.
describeDb("tool registry sync keeps adapterConfig.recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-tool-catalog-recovery-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(async () => { await db.delete(pluginEntities); await db.delete(plugins); });

  async function seed(data: Record<string, unknown>) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery Sync", issuePrefix: `R${companyId.slice(0, 5)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(plugins).values({ id: pluginId, pluginKey: "insightflo.tool-registry", packageName: "@paperclipai/plugin-tool-registry",
      version: "1.0.0", status: "ready", manifestJson: { id: "insightflo.tool-registry", name: "Tool Registry", version: "1.0.0",
        apiVersion: 1, description: "Tool Registry", capabilities: [], entrypoints: { worker: "./dist/worker.js" } } });
    await db.insert(pluginEntities).values({ pluginId, entityType: "tool-config", scopeKind: "company", scopeId: companyId,
      externalId: `${companyId}::publish`, title: "publish", status: "active", data: { name: "publish", command: "node publish.mjs", ...data } });
    return { companyId };
  }
  const load = async (companyId: string) =>
    (await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, companyId)))[0];

  it("copies a declared source recovery on create and update", async () => {
    const { companyId } = await seed({ recovery });
    await syncToolRegistryToolsToCore(db, companyId);
    expect((await load(companyId)).adapterConfig).toEqual(expect.objectContaining({ command: "node publish.mjs", recovery }));
    await syncToolRegistryToolsToCore(db, companyId);
    expect((await load(companyId)).adapterConfig).toEqual(expect.objectContaining({ recovery }));
  });

  it("preserves stored recovery when the registry source has no declaration", async () => {
    const { companyId } = await seed({});
    await db.insert(toolDefinitions).values({ companyId, name: "publish", adapterType: "builtin",
      adapterConfig: { source: "tool-registry", command: "old", recovery } });
    const result = await syncToolRegistryToolsToCore(db, companyId);
    expect(result.updatedTools).toBe(1);
    const config = (await load(companyId)).adapterConfig as Record<string, unknown>;
    expect(config.command).toBe("node publish.mjs"); // other fields still sync from source
    expect(config.recovery).toEqual(recovery);
  });

  it("does not invent a recovery key when neither side declares one", async () => {
    const { companyId } = await seed({});
    await syncToolRegistryToolsToCore(db, companyId);
    expect(Object.keys((await load(companyId)).adapterConfig as object)).not.toContain("recovery");
  });
});
