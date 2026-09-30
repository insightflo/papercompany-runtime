import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, agents, companies, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";

describe("replacement admission", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>; let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-admission-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); });
  it("authenticated agent cannot create a second top-level run by calling it board", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Admission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Admission", stepsJson: [] });
    await db.insert(workflowRuns).values({ companyId, missionId, workflowId, triggeredBy: "agent", status: "failed" });
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    await expect(workflowService.trigger(db, { companyId, missionId, workflowId, triggeredBy: "board" },
      { actor: { type: "agent", agentId: ownerAgentId, companyId } } as never)).rejects.toThrow("replacement_authority_required");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId))).toEqual(before);
  });
});
