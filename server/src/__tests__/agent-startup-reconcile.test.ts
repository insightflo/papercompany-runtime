import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcilePersistedAgentStatusOnStartup } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skip agent startup reconcile tests: ${support.reason ?? "unsupported"}`);
}

// [paperclip-stuck 2026-08-06, A1] On a cold server restart every in-memory process handle
// is gone, but agents.status can still read 'running' from the DB (phantom running).
// reconcilePersistedAgentStatusOnStartup must reset such agents to 'idle' while leaving
// agents that genuinely own a running heartbeat run untouched.
describeDb("reconcilePersistedAgentStatusOnStartup", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-startup-reconcile-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Reset agent/heartbeat state between tests so reconciled counts are exact.
  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
  });

  async function seedAgent(status: string): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Reconcile Co ${companyId.slice(0, 8)}`,
      issuePrefix: `AR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      timezone: "UTC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function getAgentStatus(agentId: string): Promise<string | null> {
    return db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]?.status ?? null);
  }

  it("resets a phantom-running agent to idle when it has no running heartbeat run", async () => {
    const { agentId } = await seedAgent("running");
    // No heartbeat_runs row → the 'running' status is a phantom left by a dead process.

    const result = await reconcilePersistedAgentStatusOnStartup(db);

    expect(result).toEqual({ reconciled: 1 });
    expect(await getAgentStatus(agentId)).toBe("idle");
  });

  it("leaves a genuinely-running agent untouched when it owns a running heartbeat run", async () => {
    const { companyId, agentId } = await seedAgent("running");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
    });

    const result = await reconcilePersistedAgentStatusOnStartup(db);

    expect(result).toEqual({ reconciled: 0 });
    expect(await getAgentStatus(agentId)).toBe("running");
  });

  it("ignores agents that are not marked running", async () => {
    const idle = await seedAgent("idle");
    const errored = await seedAgent("error");

    const result = await reconcilePersistedAgentStatusOnStartup(db);

    expect(result).toEqual({ reconciled: 0 });
    expect(await getAgentStatus(idle.agentId)).toBe("idle");
    expect(await getAgentStatus(errored.agentId)).toBe("error");
  });

  it("resets only the phantom agent when one phantom and one genuine run coexist", async () => {
    const phantom = await seedAgent("running");
    const genuine = await seedAgent("running");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: genuine.companyId,
      agentId: genuine.agentId,
      status: "running",
    });

    const result = await reconcilePersistedAgentStatusOnStartup(db);

    expect(result).toEqual({ reconciled: 1 });
    expect(await getAgentStatus(phantom.agentId)).toBe("idle");
    expect(await getAgentStatus(genuine.agentId)).toBe("running");
  });
});
