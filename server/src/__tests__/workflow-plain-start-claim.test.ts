import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, agents, companies, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executeWorkflowRunStart, type WorkflowRunStartHooks } from "../services/workflow/workflow-run-start.js";

describe("plain initial start claim (isolated PostgreSQL)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("plain-start-claim-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); });
  async function seed(status = "pending") {
    const companyId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID(), id = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Start claim", issuePrefix: id.slice(0, 8) });
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Start claim", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Start claim", stepsJson: [] });
    await db.insert(workflowRuns).values({ id, workflowId, missionId, companyId, status, triggeredBy: "test" });
    return { id, missionId };
  }
  function hooks(): WorkflowRunStartHooks {
    return {
      loadContext: async (_, id) => ({ run: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0], steps: [] }),
      assertToolsReady: async () => {}, validateStructural: async () => [], structuralTopologyErrors: () => [],
      activateMission: async () => {}, childCompletionHook: async () => false,
      snapshot: async (_, id) => { const [r] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
        return { runId: id, workflowId: r.workflowId, missionId: r.missionId, status: r.status as "running", completedAt: r.completedAt, stepRuns: [] }; },
      sync: async (_, id) => ({ kind: "synced", result: await hooks().snapshot(db, id) }),
    };
  }
  it("only one of three simultaneous starts owns initial execution", async () => {
    const s = await seed(); const h = hooks();
    const results = await Promise.all([executeWorkflowRunStart(db, s.id, h), executeWorkflowRunStart(db, s.id, h), executeWorkflowRunStart(db, s.id, h)]);
    expect(results.filter((r) => r.kind === "started")).toHaveLength(1);
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id));
    expect((await executeWorkflowRunStart(db, s.id, h)).kind).toBe("busy");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id))).toEqual(before);
  });
  it.each(["failed", "completed", "cancelled"])("%s cannot acquire initial execution", async (status) => {
    const s = await seed(status); const before = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id));
    expect((await executeWorkflowRunStart(db, s.id, hooks())).kind).toBe("ineligible");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id))).toEqual(before);
  });
  it.each(["claimed", "delivered", "generation", "forged_replacement"])("%s does not mint initial authority", async (variant) => {
    const s = await seed();
    await db.update(workflowRuns).set(variant === "generation" ? { dispatchAuthorityVersion: 1 }
      : variant === "forged_replacement" ? { metadata: { replacementAuthorityId: randomUUID() } }
      : { startedAt: new Date(), status: variant === "claimed" ? "running" : "pending" }).where(eq(workflowRuns.id, s.id));
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id));
    expect((await executeWorkflowRunStart(db, s.id, hooks())).kind).not.toBe("started");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id))).toEqual(before);
  });
  it("cancelled mission denies start without touching its pending run", async () => {
    const s = await seed(); await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id));
    expect((await executeWorkflowRunStart(db, s.id, hooks())).kind).toBe("ineligible");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.id))).toEqual(before);
  });
});
