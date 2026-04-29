import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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

  it("creates a main executor planning issue for a manual mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Mission Company",
      issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "Customer homepage rollout",
      description: "Plan and coordinate the homepage launch.",
      status: "planning",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(planningIssues).toEqual([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_plan",
        status: "todo",
        title: "[Plan] Customer homepage rollout",
      }),
    ]);
    expect(planningIssues[0]?.description).toContain("Plan and coordinate the mission");
  });

  it("does not create a manual planning issue for a workflow-created mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Company",
      issuePrefix: `WM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "2026-04-28 gazua-morning",
      description: "Created automatically for workflow run: gazua-morning",
      status: "active",
      source: "workflow",
    });

    const planningIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));

    expect(planningIssues).toEqual([]);
  });

  it("reuses an existing active workflow mission with the same company, title, and workflow description", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Dedup Company",
      issuePrefix: `WD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const input = {
      companyId,
      ownerAgentId,
      title: "2026-04-30 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active" as const,
      source: "workflow" as const,
    };

    const first = await missionService(db).create(input);
    const second = await missionService(db).create(input);
    const missionRows = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, companyId));

    expect(second.id).toBe(first.id);
    expect(missionRows).toHaveLength(1);
  });

  it("filters listed missions by inclusive created date range", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Date Filter Mission Company",
      issuePrefix: `DF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values([
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Before range",
        status: "active",
        createdAt: new Date("2026-03-31T23:59:59.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range start",
        status: "active",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range end",
        status: "active",
        createdAt: new Date("2026-04-29T23:59:59.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "After range",
        status: "active",
        createdAt: new Date("2026-04-30T00:00:00.000Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      from: "2026-04-01",
      to: "2026-04-29",
      sortBy: "createdAt",
      sortOrder: "asc",
    });

    expect(result.map((mission) => mission.title)).toEqual([
      "Inside range start",
      "Inside range end",
    ]);
  });

  it("rejects non-UUID mission ids before mission subresource queries", async () => {
    const svc = missionService(db);

    await expect(svc.getById("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.getIssueTree("mission-1")).rejects.toMatchObject({ status: 400 });
    await expect(svc.listWorkflowRuns("mission-1")).rejects.toMatchObject({ status: 400 });
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

  it("updates active workflow-created missions when all linked plugin runs are terminal", async () => {
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
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
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
    const activeList = await svc.list({ companyId, status: "active" });
    const detail = await svc.getById(missionId);
    const listed = await svc.list({ companyId });

    expect(activeList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-27T00:42:33.653Z"));
    expect(listed.find((mission) => mission.id === missionId)?.status).toBe("cancelled");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
  });

  it("corrects a prematurely completed workflow-created mission when its linked plugin run later aborts", async () => {
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
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
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
      status: "aborted",
      data: {
        workflowId: randomUUID(),
        workflowName: "gazua-morning",
        companyId,
        missionId,
        status: "aborted",
        triggerSource: "schedule",
        runLabel: "#2026-04-28-1",
        startedAt: "2026-04-27T22:00:06.773Z",
        completedAt: "2026-04-28T00:10:29.987Z",
      },
    });

    const svc = missionService(db);
    const completedList = await svc.list({ companyId, status: "completed" });
    const detail = await svc.getById(missionId);
    const cancelledList = await svc.list({ companyId, status: "cancelled" });

    expect(completedList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
    expect(cancelledList.find((mission) => mission.id === missionId)?.status).toBe("cancelled");

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("cancelled");
  });

  it("reactivates a prematurely cancelled workflow-created mission while a linked plugin run is still active", async () => {
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
      manifestJson: { id: "insightflo.workflow-engine", name: "Workflow Engine", version: "1.0.0" },
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
    const cancelledList = await svc.list({ companyId, status: "cancelled" });
    const activeList = await svc.list({ companyId, status: "active" });
    const detail = await svc.getById(missionId);

    expect(cancelledList.find((mission) => mission.id === missionId)).toBeUndefined();
    expect(activeList.find((mission) => mission.id === missionId)?.status).toBe("active");
    expect(detail.status).toBe("active");
    expect(detail.completedAt).toBeNull();

    const [stored] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(stored?.status).toBe("active");
    expect(stored?.completedAt).toBeNull();
  });

  it("does not reactivate an ordinary manually cancelled mission with no workflow-created marker", async () => {
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
    const detail = await svc.getById(missionId);
    expect(detail.status).toBe("cancelled");
    expect(detail.completedAt).toEqual(new Date("2026-04-28T00:10:29.987Z"));
  });

  it("links plugin workflow step issue ancestors to the mission before returning the issue tree", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const parentIssueId = randomUUID();
    const stepIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Issue Company",
      issuePrefix: `PI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
        title: "tech-scout",
        status: "active",
        data: { name: "tech-scout", companyId, steps: [{ id: "scout", title: "Scout", dependsOn: [] }] },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "tech-scout run",
        status: "running",
        data: {
          workflowId,
          workflowName: "tech-scout",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scout`,
        title: "scout",
        status: "completed",
        data: { runId, stepId: "scout", issueId: stepIssueId, status: "completed" },
      },
    ]);

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId: null,
        title: "[tech-scout] #2026-04-27-1",
        status: "backlog",
        priority: "medium",
        identifier: "PI-1",
      },
      {
        id: stepIssueId,
        companyId,
        missionId: null,
        parentId: parentIssueId,
        title: "[tech-scout] 2026-04-27 기술 리서치 리포트",
        status: "done",
        priority: "high",
        identifier: "PI-2",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result.map((issue) => issue.id)).toEqual(expect.arrayContaining([parentIssueId, stepIssueId]));
    expect(result.find((issue) => issue.id === stepIssueId)?.parentId).toBe(parentIssueId);

    const stored = await db
      .select({ id: issues.id, missionId: issues.missionId })
      .from(issues)
      .where(inArray(issues.id, [parentIssueId, stepIssueId]));
    expect(stored).toEqual(
      expect.arrayContaining([
        { id: parentIssueId, missionId },
        { id: stepIssueId, missionId },
      ]),
    );
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
