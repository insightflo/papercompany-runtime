import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: heartbeatWakeup,
  }),
}));

import { issueService } from "../services/issues.ts";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow DAG tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeWorkflowRun issue lifecycle parity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-dag-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates workflow definitions from plugin UI step payloads", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Plugin UI Workflow",
      steps: [
        {
          id: "qa-step",
          title: "QA step",
          description: "Use this step only for QA usability verification.",
          type: "agent",
          dependsOn: [],
        },
      ] as never,
    });

    expect(definition.name).toBe("Plugin UI Workflow");
    expect(definition.steps).toEqual([
      expect.objectContaining({
        id: "qa-step",
        name: "QA step",
        dependencies: [],
      }),
    ]);
  });

  it("creates workflow entry step issues through the common lifecycle path and keeps the run active", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "draft-plan";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Roadmap Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Draft plan",
          agentId,
          dependencies: [],
          description: "Prepare the first implementation plan",
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    expect(result.stepRuns).toHaveLength(1);
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();

    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue).toMatchObject({
      companyId,
      title: "Roadmap Workflow: Draft plan",
      status: "todo",
      assigneeAgentId: agentId,
      missionId: null,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    expect(createdIssue?.identifier).toMatch(/^WF[A-Z0-9]+-1$/);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, createdIssue!.id))
      .then((rows) => rows.find((row) => row.action === "issue.created") ?? null);
    expect(activity).toMatchObject({
      companyId,
      actorType: "system",
      actorId: `workflow:${workflowId}`,
      action: "issue.created",
      entityType: "issue",
      entityId: createdIssue!.id,
    });
    expect(activity?.details).toEqual({
      title: "Roadmap Workflow: Draft plan",
      identifier: createdIssue!.identifier,
    });

    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: createdIssue!.id, mutation: "create" },
      requestedByActorType: "system",
      requestedByActorId: `workflow:${workflowId}`,
      contextSnapshot: { issueId: createdIssue!.id, source: "workflow.dispatch" },
    }));

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("running");
  });

  it("progresses dependent steps and completes the workflow as execution issues complete", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-2" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Progression",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Workflow Agent A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Workflow Agent B",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentAId,
      title: "Workflow Mission",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Execution Workflow",
      stepsJson: [
        { id: "plan", name: "Plan", agentId: agentAId, dependencies: [], description: "Create the plan" },
        { id: "build", name: "Build", agentId: agentBId, dependencies: ["plan"], description: "Implement the plan" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");
    expect(initial.stepRuns).toHaveLength(2);

    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const planStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const buildStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(planStepRun?.issueId).toBeTruthy();
    expect(buildStepRun?.issueId).toBeNull();

    const planIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, planStepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(planIssue?.missionId).toBe(missionId);

    await issueSvc.update(planIssue!.id, { status: "done" });
    const afterPlan = await syncWorkflowRunForIssue(db, planIssue!.id);
    expect(afterPlan?.status).toBe("running");

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedPlan = progressedStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const progressedBuild = progressedStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(progressedPlan?.status).toBe("completed");
    expect(progressedBuild?.issueId).toBeTruthy();

    await issueSvc.update(progressedBuild!.issueId!, { status: "done" });
    const afterBuild = await syncWorkflowRunForIssue(db, progressedBuild!.issueId!);
    expect(afterBuild?.status).toBe("completed");

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.completedAt).toBeTruthy();
  });

  it("completes issue-less tool steps and advances dependent agent steps", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-tool-agent" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Tool Workflow",
      issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Projection Workflow",
      stepsJson: [
        {
          id: "fetch-context",
          name: "Fetch context",
          agentId: "",
          dependencies: [],
          description: "Load context through a workflow tool",
          toolNames: ["search-docs"],
        },
        {
          id: "summarize",
          name: "Summarize",
          agentId,
          dependencies: ["fetch-context"],
          description: "Summarize the context",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);
    expect(result.status).toBe("running");

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const toolStep = stepRuns.find((stepRun) => stepRun.stepId === "fetch-context");
    const agentStep = stepRuns.find((stepRun) => stepRun.stepId === "summarize");

    expect(toolStep).toMatchObject({
      issueId: null,
      status: "completed",
    });
    expect(toolStep?.startedAt).toBeTruthy();
    expect(toolStep?.completedAt).toBeTruthy();
    expect(agentStep?.issueId).toBeTruthy();
    expect(agentStep?.status).toBe("pending");

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: "Tool Projection Workflow: Summarize",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
  });

  it("completes all-tool workflows without creating issues", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Tool Only Workflow",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Only Workflow",
      stepsJson: [
        {
          id: "fetch",
          name: "Fetch",
          agentId: "",
          dependencies: [],
          toolNames: ["search-docs"],
        },
        {
          id: "extract",
          name: "Extract",
          agentId: "",
          dependencies: ["fetch"],
          toolNames: ["extract-facts"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);
    expect(result.status).toBe("completed");

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "fetch", issueId: null, status: "completed" }),
        expect.objectContaining({ stepId: "extract", issueId: null, status: "completed" }),
      ]),
    );
    expect(stepRuns.every((stepRun) => stepRun.startedAt && stepRun.completedAt)).toBe(true);

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(0);

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.completedAt).toBeTruthy();
  });

  it("fails the workflow and skips dependent steps when a prerequisite execution issue fails", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-3" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Failure",
      issuePrefix: `WX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Failure Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Failure Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship the work" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    await executeWorkflowRun(db, runId);
    const prepareStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "prepare") ?? null);

    await issueSvc.update(prepareStepRun!.issueId!, { status: "blocked" });
    const failed = await syncWorkflowRunForIssue(db, prepareStepRun!.issueId!);
    expect(failed?.status).toBe("failed");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const prepare = finalStepRuns.find((stepRun) => stepRun.stepId === "prepare");
    const ship = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(prepare?.status).toBe("failed");
    expect(ship?.status).toBe("skipped");
    expect(ship?.issueId).toBeNull();
  });
});
