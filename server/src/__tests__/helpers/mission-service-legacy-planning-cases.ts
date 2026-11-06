import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, pluginEntities, plugins, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { issueService } from "../../services/issues.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionLegacyPlanningCases(getDb: () => ReturnType<typeof createDb>) {
  it("cancels stale legacy plugin-only workflow-created missions with no native run", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy Plugin Reconcile Company",
      issuePrefix: `LP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-10 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    const oversightIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] 2026-06-10 gazua-watchlist-refresh",
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
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "legacy gazua-watchlist-refresh run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-watchlist-refresh",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        startedAt: "2020-01-01T00:00:00.000Z",
      },
      updatedAt: new Date("2020-01-01T00:05:00.000Z"),
    });

    const detail = await missionService(db).reconcileById(missionId);

    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2020-01-01T00:05:00.000Z"));

    const [storedMission] = await db.select().from(missions).where(eq(missions.id, missionId));
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssue.id));
    expect(storedMission?.status).toBe("cancelled");
    expect(storedOversight?.status).toBe("cancelled");
    expect(storedOversight?.cancelledAt).toEqual(new Date("2020-01-01T00:05:00.000Z"));
  });

  it("does not promote a planning mission from legacy plugin workflow run state", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Workflow Promotion Company",
      issuePrefix: `PP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Manual mission with plugin execution",
      status: "planning",
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
      title: "failed workflow run",
      status: "failed",
      data: {
        workflowId: randomUUID(),
        workflowName: "manual-mission-workflow",
        companyId,
        missionId,
        status: "failed",
        triggerSource: "manual",
        startedAt: "2026-06-09T04:00:04.837Z",
        completedAt: "2026-06-09T04:23:25.320Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    const planningList = await svc.list({ companyId, status: "planning" });
    const activeList = await svc.list({ companyId, status: "active" });

    expect(planningList.find((mission) => mission.id === missionId)?.status).toBe("planning");
    expect(detail.status).toBe("planning");
    expect(detail.startedAt).toBeNull();
    expect(detail.completedAt).toBeNull();
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("planning");
    expect(stored?.startedAt).toBeNull();
    expect(stored?.completedAt).toBeNull();
  });

  it("does not complete a planning mission only because linked plugin workflow runs are terminal", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Terminal Workflow Company",
      issuePrefix: `PT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Planning mission with completed plugin run",
      status: "planning",
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
      title: "completed workflow run",
      status: "completed",
      data: {
        workflowId: randomUUID(),
        workflowName: "manual-mission-workflow",
        companyId,
        missionId,
        status: "completed",
        triggerSource: "manual",
        startedAt: "2026-06-09T04:00:04.837Z",
        completedAt: "2026-06-09T04:23:25.320Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);

    expect(detail.status).toBe("planning");
    expect(detail.startedAt).toBeNull();
    expect(detail.completedAt).toBeNull();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("planning");
    expect(stored?.startedAt).toBeNull();
    expect(stored?.completedAt).toBeNull();
  });

}
