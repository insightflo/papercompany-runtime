import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { agents, companies, createDb, issues, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createMissionRecord } from "../services/missions/mission-create-records.js";
import { missionService } from "../services/missions.js";

// Removing creation-time source validation makes the rejection/before-mutation assertions fail.
describe("mission revision source links (isolated DB)", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-source-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function world() {
    const companyId = randomUUID(), ownerAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revision", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
    const input = { companyId, ownerAgentId, title: "Source", description: null, goalId: null, projectId: null, status: "planning" };
    const source = await createMissionRecord(db, input);
    const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Revision", stepsJson: [] }).returning();
    return { input, source, definition };
  }
  it("rejects foreign-company source before mission creation", async () => {
    const a = await world(), b = await world();
    const before = await db.select({ n: count() }).from(missions);
    await expect(missionService(db).create({ ...a.input, description: undefined, goalId: undefined, projectId: undefined,
      status: "planning", sourceMissionId: b.source.id })).rejects.toThrow("source mission");
    expect(await db.select({ n: count() }).from(missions)).toEqual(before);
  });
  it("rejects a run of another mission, including a foreign-company run", async () => {
    const a = await world(), b = await world();
    const another = await createMissionRecord(db, a.input);
    for (const owner of [a, b]) {
      const [run] = await db.insert(workflowRuns).values({ companyId: owner.input.companyId, workflowId: owner.definition.id,
        missionId: owner.source.id, triggeredBy: "manual" }).returning();
      await expect(createMissionRecord(db, { ...a.input, sourceMissionId: another.id, sourceWorkflowRunId: run.id }))
        .rejects.toThrow("source workflow run");
    }
  });
  it("pins latest source run by createdAt then id, or null when no run exists", async () => {
    const a = await world();
    const first = await createMissionRecord(db, { ...a.input, sourceMissionId: a.source.id });
    expect(first.sourceMissionId).toBe(a.source.id);
    expect(first.sourceWorkflowRunId).toBeNull();
    const ids = [randomUUID(), randomUUID()].sort();
    await db.insert(workflowRuns).values(ids.map(id => ({ id, companyId: a.input.companyId, workflowId: a.definition.id,
      missionId: a.source.id, triggeredBy: "manual", createdAt: new Date("2026-01-01") })));
    const revision = await createMissionRecord(db, { ...a.input, sourceMissionId: a.source.id });
    expect(revision.sourceWorkflowRunId).toBe(ids[1]);
    const [saved] = await db.select().from(missions).where(eq(missions.id, revision.id));
    expect(saved.sourceMissionId).toBe(a.source.id);
    const created = await missionService(db).create({ companyId: a.input.companyId, ownerAgentId: a.input.ownerAgentId,
      title: "Real planning path", sourceMissionId: a.source.id });
    const plans = await db.select().from(issues).where(eq(issues.missionId, created.id));
    expect(plans.find(issue => issue.originKind === "mission_main_executor_plan")?.description)
      .toContain(`"sourceWorkflowRunId":"${ids[1]}"`);
    await expect(createMissionRecord(db, { ...a.input, sourceWorkflowRunId: ids[0] })).rejects.toThrow("sourceMissionId");
  });
});
