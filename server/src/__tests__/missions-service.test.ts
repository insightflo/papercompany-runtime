import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
  pluginEntities,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("mission service mission-linked subresources", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-missions-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a mission with the owner as a valid mission agent", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Create Mission Company",
      issuePrefix: `CM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    const svc = missionService(db);
    const result = await svc.create({
      companyId,
      ownerAgentId,
      title: "QA launch readiness mission",
      description: "Regression coverage for mission creation from the UI.",
      status: "planning",
    });

    expect(result.title).toBe("QA launch readiness mission");
    expect(result.ownerAgentId).toBe(ownerAgentId);
    expect(result.agents).toEqual([
      expect.objectContaining({
        missionId: result.id,
        agentId: ownerAgentId,
        role: "executor",
      }),
    ]);
  });

  it("returns mission-linked issues through getIssueTree", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Company",
      issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Ship Mission",
      status: "active",
    });

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        missionId,
        title: "Root issue",
        status: "todo",
        priority: "high",
        identifier: "MS-1",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: rootIssueId,
        title: "Child issue",
        status: "in_progress",
        priority: "medium",
        identifier: "MS-2",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result).toHaveLength(2);
    expect(result.map((issue) => issue.id)).toEqual(expect.arrayContaining([rootIssueId, childIssueId]));
    expect(result.find((issue) => issue.id === childIssueId)?.parentId).toBe(rootIssueId);
  });

  it("returns mission-linked workflow runs with step runs", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Company",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Workflow Mission",
      status: "active",
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Launch Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId: ownerAgentId,
          dependencies: [],
          toolNames: ["search-docs"],
          knowledgeBaseIds: ["kb-product"],
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Draft mission brief",
      status: "in_progress",
      priority: "high",
      identifier: "WF-11",
      assigneeAgentId: ownerAgentId,
    });

    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        workflowName: "Launch Workflow",
      }),
    );
    expect(result[0]?.stepRuns).toEqual([
      expect.objectContaining({
        id: stepRunId,
        workflowRunId: runId,
        stepId: "draft",
        issueId,
      }),
    ]);
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "draft",
        name: "Draft",
        agentId: ownerAgentId,
        toolNames: ["search-docs"],
        knowledgeBaseIds: ["kb-product"],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "WF-11",
          title: "Draft mission brief",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
      }),
    ]);
    expect(result[0]?.progress).toEqual({
      totalSteps: 1,
      pendingSteps: 0,
      runningSteps: 1,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
    });
  });

  it("returns plugin entity workflow runs linked to a mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Company",
      issuePrefix: `PW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Plugin Workflow Mission",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });

    await db.insert(pluginEntities).values([
      {
        id: workflowId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-definition:${workflowId}`,
        title: "Scheduled Plugin Workflow",
        status: "active",
        data: {
          name: "Scheduled Plugin Workflow",
          description: "Scheduled plugin run should show on mission execution flow.",
          companyId,
          status: "active",
          steps: [
            {
              id: "scheduled-step",
              title: "Scheduled E2E pass step",
              dependsOn: [],
              type: "agent",
              agentName: "Workflow Owner",
            },
          ],
        },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "Scheduled Plugin Workflow run",
        status: "running",
        data: {
          workflowId,
          workflowName: "Scheduled Plugin Workflow",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scheduled-step`,
        title: "scheduled-step",
        status: "in_progress",
        data: {
          runId,
          stepId: "scheduled-step",
          issueId,
          agentName: "Workflow Owner",
          status: "in_progress",
          retryCount: 0,
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Scheduled plugin step issue",
      status: "in_progress",
      priority: "high",
      identifier: "PW-11",
      assigneeAgentId: ownerAgentId,
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        companyId,
        workflowName: "Scheduled Plugin Workflow",
        status: "running",
        triggeredBy: "schedule",
      }),
    );
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "scheduled-step",
        name: "Scheduled E2E pass step",
        agentId: ownerAgentId,
        dependencies: [],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "PW-11",
          title: "Scheduled plugin step issue",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
      }),
    ]);
  });
});
