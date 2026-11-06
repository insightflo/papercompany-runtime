import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, missions, pluginEntities, plugins, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionCancelledMissionCases(getDb: () => ReturnType<typeof createDb>) {
  it("does not reactivate an operator-cancelled workflow-created mission while a linked plugin run is still active", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Premature Cancelled Workflow Company",
      issuePrefix: `PX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "cancelled",
      completedAt: new Date("2026-04-28T00:10:29.987Z"),
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: missionPluginManifest("insightflo.workflow-engine", "Workflow Engine", "1.0.0"),
      status: "ready",
    });

    await db.insert(pluginEntities).values({
      id: runId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${runId}`,
      title: "gazua-morning #2026-04-28-1",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: null,
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    const cancelledList = await svc.list({ companyId, status: "cancelled" });
    const activeList = await svc.list({ companyId, status: "active" });

    expect(cancelledList.find((mission) => mission.id === missionId)?.status).toBe("cancelled");
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
    expect(stored?.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
  });

  it("does not reactivate an ordinary manually cancelled mission with no workflow-created marker", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Manual Cancelled Mission Company",
      issuePrefix: `MC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Manual mission",
      description: "Operator cancelled this manually",
      status: "cancelled",
      completedAt: new Date("2026-04-28T00:10:29.987Z"),
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
  });

}
