import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("plugin host approvals.create (external_automation)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  const pluginId = "insightflo.github-repository-bridge";
  const pluginKey = "insightflo/github-repository-bridge";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-host-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Host Co",
      issuePrefix: `AH${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  function services() {
    const host = buildHostServices(db, pluginId, pluginKey, createPluginEventBus());
    return host;
  }

  it("creates a pending external_automation approval attributed to the plugin with title/summary in payload", async () => {
    await seedCompany();
    const approval = await services().approvals.create({
      companyId,
      type: "external_automation",
      payload: { repository: "acme/runtime", branch: "main", commit: "deadbeef" },
      title: "Deploy acme/runtime main",
      summary: "All required checks passed for deadbeef.",
    });

    expect(approval.type).toBe("external_automation");
    expect(approval.status).toBe("pending");
    expect(approval.requestedByPluginId).toBe(pluginId);
    expect(approval.requestedByAgentId).toBeNull();
    // title/summary are stored inside the payload (human-readable), not leaked elsewhere.
    expect(approval.payload.title).toBe("Deploy acme/runtime main");
    expect(approval.payload.summary).toBe("All required checks passed for deadbeef.");
    expect(approval.payload.repository).toBe("acme/runtime");
    expect(approval.payload.commit).toBe("deadbeef");

    const persisted = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(persisted[0]?.requestedByPluginId).toBe(pluginId);
  });

  it("rejects an unsupported approval type (runtime schema validation)", async () => {
    await seedCompany();
    await expect(
      services().approvals.create({ companyId, type: "not_a_real_type", payload: {} }),
    ).rejects.toThrow(/unsupported approval type/);
  });

  it("records an approval.created activity entry", async () => {
    await seedCompany();
    const approval = await services().approvals.create({
      companyId,
      type: "external_automation",
      payload: { repository: "acme/runtime", branch: "main", commit: "cafebabe" },
    });
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, approval.id));
    expect(rows.some((row) => row.action === "approval.created")).toBe(true);
  });
});
