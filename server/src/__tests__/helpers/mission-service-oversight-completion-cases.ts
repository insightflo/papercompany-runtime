import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, pluginEntities, plugins, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionOversightCompletionCases(getDb: () => ReturnType<typeof createDb>) {
  it("does not terminalize active workflow-created missions from legacy plugin-only terminal runs", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Plugin Workflow Company",
      issuePrefix: `TP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "2026-04-27 tech-scout",
      description: "Created automatically for workflow run: tech-scout",
      status: "active",
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
      title: "tech-scout run",
      status: "aborted",
      data: {
        workflowId: randomUUID(),
        workflowName: "tech-scout",
        companyId,
        missionId,
        status: "aborted",
        triggerSource: "schedule",
        startedAt: "2026-04-27T00:41:03.618Z",
        completedAt: "2026-04-27T00:42:33.653Z",
      },
    });

    const svc = missionService(db);
    const detail = await svc.reconcileById(missionId);
    const activeList = await svc.list({ companyId, status: "active" });
    const listed = await svc.list({ companyId });

    expect(activeList.find((mission) => mission.id === missionId)?.status).toBe("active");
    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();
    expect(listed.find((mission) => mission.id === missionId)?.status).toBe("active");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("active");
    expect(stored?.completedAt).toBeNull();
  });

  it("auto-completes mission oversight when a linked native workflow run completes with no remaining work", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const workflowIssueId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Completed Native Workflow Company",
      issuePrefix: `CN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Native workflow mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: workflowIssueId,
        companyId,
        missionId,
        title: "Finished workflow step",
        status: "done",
        priority: "medium",
        originKind: "workflow_execution",
        completedAt: new Date("2026-06-09T04:39:18.034Z"),
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Native workflow mission",
        status: "todo",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Native workflow",
      stepsJson: [{ id: "qa", name: "QA", agentId: ownerAgentId }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      status: "completed",
      triggeredBy: "test",
      startedAt: new Date("2026-06-09T04:00:04.837Z"),
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "qa",
      issueId: workflowIssueId,
      status: "completed",
      startedAt: new Date("2026-06-09T04:38:38.108Z"),
      completedAt: new Date("2026-06-09T04:39:18.034Z"),
    });

    const detail = await missionService(db).reconcileById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(detail.status).toBe("completed");
    expect(oversight?.status).toBe("done");
    expect(oversight?.completedAt).toEqual(new Date("2026-06-09T04:41:12.533Z"));
  });

  it("does not auto-complete mission oversight while non-oversight work remains open", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Open Work Oversight Company",
      issuePrefix: `OW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Completed mission with open work",
      status: "completed",
      completedAt: new Date("2026-06-09T04:41:12.533Z"),
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        missionId,
        title: "Open follow-up",
        status: "todo",
        priority: "medium",
        originKind: "workflow_execution",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        title: "[OVERSIGHT] Completed mission with open work",
        status: "todo",
        priority: "medium",
        originKind: "mission_main_executor_oversight",
      },
    ]);

    await missionService(db).reconcileById(missionId);
    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));

    expect(oversight?.status).toBe("todo");
    expect(oversight?.completedAt).toBeNull();
  });
}
