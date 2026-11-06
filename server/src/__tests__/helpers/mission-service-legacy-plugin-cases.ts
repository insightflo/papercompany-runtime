import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, pluginEntities, plugins, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { issueService } from "../../services/issues.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionLegacyPluginCases(getDb: () => ReturnType<typeof createDb>) {
  it("does not reactivate a completed workflow-created mission from legacy plugin run state", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Premature Completed Workflow Company",
      issuePrefix: `PC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      status: "completed",
      completedAt: new Date("2026-04-27T23:51:06.620Z"),
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
      status: "failed",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "failed",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: "2026-04-28T00:10:29.987Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    const completedList = await svc.list({ companyId, status: "completed" });
    const activeList = await svc.list({ companyId, status: "active" });

    expect(completedList.find((mission) => mission.id === missionId)?.status).toBe("completed");
    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-04-27T23:51:06.620Z"));
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("completed");
    expect(stored?.completedAt).toEqual(new Date("2026-04-27T23:51:06.620Z"));
  });

  it("does not reactivate an operator-completed workflow-created mission while a linked native run is still active", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Operator Completed Workflow Company",
      issuePrefix: `OC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-09 tech-scout",
      description: "Created automatically for workflow run: tech-scout",
      status: "completed",
      startedAt: new Date("2026-06-09T07:44:21.648Z"),
      completedAt: new Date("2026-06-09T11:39:30.000Z"),
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-scout",
      stepsJson: [{ id: "publish", name: "Publish", agentId: ownerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "running",
      triggeredBy: "board",
      startedAt: new Date("2026-06-09T07:44:21.655Z"),
      completedAt: null,
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    const completedList = await svc.list({ companyId, status: "completed" });
    const activeList = await svc.list({ companyId, status: "active" });

    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-06-09T11:39:30.000Z"));
    expect(completedList.find((mission) => mission.id === missionId)?.status).toBe("completed");
    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("completed");
    expect(stored?.completedAt).toEqual(new Date("2026-06-09T11:39:30.000Z"));
  });

  it("completes an active workflow-created mission from the latest native run despite stale plugin run state", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const failedRunId = randomUUID();
    const completedRunId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Native Workflow Reconcile Company",
      issuePrefix: `NW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-06-10 gazua-macro-sentinel",
      description: "Created automatically for workflow run: gazua-macro-sentinel",
      status: "active",
      startedAt: new Date("2026-06-10T01:00:00.000Z"),
      completedAt: null,
    });
    const oversightIssue = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] 2026-06-10 gazua-macro-sentinel",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-macro-sentinel",
      stepsJson: [{ id: "collect", name: "Collect", agentId: ownerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values([
      {
        id: failedRunId,
        workflowId,
        companyId,
        missionId,
        status: "failed",
        triggeredBy: "schedule",
        createdAt: new Date("2026-06-10T01:00:00.000Z"),
        startedAt: new Date("2026-06-10T01:00:00.000Z"),
        completedAt: new Date("2026-06-10T01:05:00.000Z"),
      },
      {
        id: completedRunId,
        workflowId,
        companyId,
        missionId,
        status: "completed",
        triggeredBy: "schedule",
        createdAt: new Date("2026-06-10T02:00:00.000Z"),
        startedAt: new Date("2026-06-10T02:00:00.000Z"),
        completedAt: new Date("2026-06-10T02:08:00.000Z"),
      },
    ]);
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
      title: "legacy gazua-macro-sentinel run",
      status: "running",
      data: {
        workflowId,
        workflowName: "gazua-macro-sentinel",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
        startedAt: "2026-06-10T00:00:00.000Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);

    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));

    const [storedMission] = await db.select().from(missions).where(eq(missions.id, missionId));
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssue.id));
    expect(storedMission?.status).toBe("completed");
    expect(storedMission?.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));
    expect(storedOversight?.status).toBe("done");
    expect(storedOversight?.completedAt).toEqual(new Date("2026-06-10T02:08:00.000Z"));
  });

}
