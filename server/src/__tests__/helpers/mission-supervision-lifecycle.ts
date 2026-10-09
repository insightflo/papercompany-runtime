import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, issues, missions, pluginEntities, plugins, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";

export async function seedSupervisionLifecycle(db: Db, status = "active", runStatus: string | null = "completed") {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const completedAt = new Date("2026-10-01T00:00:00.000Z");
  await db.insert(companies).values({ id: companyId, name: "Supervision lifecycle", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active", adapterType: "codex_local" });
  const [mission] = await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId, title: "Lifecycle", status,
    description: "Created automatically for workflow run: fixture", startedAt: completedAt,
    completedAt: status === "completed" ? completedAt : null,
  }).returning();
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Lifecycle", stepsJson: [] }).returning();
  const addRun = async (state: string, createdAt = new Date("2026-10-01T00:00:00.000Z")) =>
    (await db.insert(workflowRuns).values({ companyId, missionId, workflowId: definition.id, triggeredBy: "test",
      status: state, createdAt, startedAt: completedAt, completedAt: state === "running" ? null : completedAt }).returning())[0];
  const run = runStatus ? await addRun(runStatus) : null;
  const addIssue = async (originKind: string, issueStatus = "todo", originId: string | null = null) =>
    (await db.insert(issues).values({ companyId, missionId, title: originKind, originKind, originId,
      status: issueStatus, assigneeAgentId: agentId, completedAt: issueStatus === "done" ? completedAt : null }).returning())[0];
  const stored = async () => (await db.select().from(missions).where(eq(missions.id, missionId)))[0];
  const work = () => db.select().from(issues).where(eq(issues.missionId, missionId)).orderBy(issues.id);
  return { companyId, agentId, missionId, mission, run, completedAt, addRun, addIssue, stored, work };
}

export async function addLegacyRun(db: Db, f: Awaited<ReturnType<typeof seedSupervisionLifecycle>>, status = "completed") {
  // Use actual plugin schema without fabricating a manifest type; this fixture never loads a plugin worker.
  const pluginKey = `test-${randomUUID()}`;
  const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "1.0.0",
    manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fixture", description: "Fixture",
      author: "test", categories: [], capabilities: [], entrypoints: { worker: "unused.js" } } }).returning();
  await db.insert(pluginEntities).values({ pluginId: plugin.id, entityType: "workflow-run", scopeKind: "company", scopeId: f.companyId,
    status, data: { companyId: f.companyId, missionId: f.missionId, status }, updatedAt: f.completedAt });
}
