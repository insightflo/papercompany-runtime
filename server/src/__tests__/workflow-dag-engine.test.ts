import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missionPlanArtifacts,
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
import { missionService } from "../services/missions.js";
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
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
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

  it("creates a mission for a workflow trigger without an existing mission and links run and step issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const stepId = "collect-news";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Papercompany Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tech Scout Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "tech-scout report 생성",
      steps: [
        {
          id: stepId,
          name: "Collect AI infra news",
          agentId,
          dependencies: [],
          description: "Collect source material for the daily tech scout report",
        },
      ],
    });

    const result = await workflowService.trigger(db, {
      companyId,
      workflowId: definition.id,
      triggeredBy: "manual",
    });

    expect(result.status).toBe("running");

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId))
      .limit(1);
    expect(run?.missionId).toBeTruthy();

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);
    expect(mission).toMatchObject({
      companyId,
      ownerAgentId: agentId,
      title: expect.stringContaining("tech-scout report 생성"),
      status: "active",
    });

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId))
      .limit(1);
    const [stepIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId!))
      .limit(1);
    expect(stepIssue).toMatchObject({
      missionId: run!.missionId,
      originKind: "workflow_execution",
      originId: result.runId,
      assigneeAgentId: agentId,
    });

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, run!.missionId!));
    expect(missionIssues.find((issue) => issue.originKind === "mission_main_executor_plan")).toBeUndefined();
    const oversight = missionIssues.find((issue) => issue.originKind === "mission_main_executor_oversight");
    expect(oversight).toMatchObject({
      assigneeAgentId: agentId,
      missionId: run!.missionId,
      status: "todo",
      title: "[Oversight] tech-scout report 생성",
    });

    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, run!.missionId!));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        ownerAgentId: agentId,
        revision: 1,
        status: "active",
        refs: expect.objectContaining({
          oversightIssueId: oversight!.id,
          sourceRunId: result.runId,
          workflowName: "tech-scout report 생성",
          workflowStepIds: [stepId],
        }),
      }),
    ]);
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

  it("creates unassigned issues for workflow steps without an agent", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Unassigned Workflow",
      issuePrefix: `WU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unassigned Workflow",
      stepsJson: [
        {
          id: "manual-review",
          name: "Manual review",
          agentId: "",
          dependencies: [],
          description: "Needs operator assignment later",
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

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: "Unassigned Workflow: Manual review",
      assigneeAgentId: null,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).not.toHaveBeenCalled();
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
    const missionId = randomUUID();

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
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Failure Workflow Mission",
      status: "active",
    });
    const issueSvc = issueService(db);
    const oversightIssue = await issueSvc.create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[Oversight] Failure Workflow",
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
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

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

    const oversightComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    expect(oversightComments.map((comment) => comment.body).join("\n")).toContain("Workflow step failed");
    expect(oversightComments.map((comment) => comment.body).join("\n")).toContain("prepare");
    expect(oversightComments[0]?.authorAgentId).toBe(agentId);

    await db.delete(issueComments).where(eq(issueComments.issueId, oversightIssue.id));

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(supervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(supervision.findings.join("\n")).toContain("blocked_without_replan");
    expect(supervision.findings.join("\n")).toContain("failed_step_without_diagnosis");
    const commentsAfterSupervision = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    expect(commentsAfterSupervision.map((comment) => comment.body).join("\n")).toContain("Mission owner supervision diagnosis");
  });

  it("observes stale workflow todo dispatch omissions without hard-blocking", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Supervision",
      issuePrefix: `WS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Supervisor Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Supervision Workflow Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Supervision Workflow",
      stepsJson: [
        { id: "publish", name: "Publish", agentId, dependencies: [], description: "Publish the output" },
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

    const issueSvc = issueService(db);
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Supervision Workflow Mission", description: null, status: "active", source: "manual", createdAt: new Date(), updatedAt: new Date() },
      "Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["publish"] },
    );
    const stepIssue = await issueSvc.create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "todo",
      title: "Supervision Workflow: Publish",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "publish",
      issueId: stepIssue.id,
      status: "pending",
    });

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(supervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(supervision.findings.join("\n")).toContain("stale_todo");
    expect(supervision.findings.join("\n")).toContain("dispatch_omission");

    const [planArtifact] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .limit(1);
    expect(planArtifact.refs).toEqual(expect.objectContaining({
      oversightIssueId: oversightIssue.id,
      sourceRunId: runId,
      workflowName: "Supervision Workflow",
      workflowStepIds: ["publish"],
    }));
    const [stepIssueAfter] = await db.select().from(issues).where(eq(issues.id, stepIssue.id)).limit(1);
    expect(stepIssueAfter.status).toBe("todo");

    const repeatedSameFinding = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(repeatedSameFinding.commented).toBe(false);

    await issueSvc.update(stepIssue.id, { status: "blocked" });
    const newFindingSameHour = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(newFindingSameHour.commented).toBe(true);
    expect(newFindingSameHour.findings.join("\n")).toContain("blocked_without_replan");

    const commentsAfterSignatureDedupe = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    expect(commentsAfterSignatureDedupe).toHaveLength(2);
  });

  it("runs active mission owner supervision and applies only safe workflow dispatch sync", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Active Supervision",
      issuePrefix: `AS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Active Supervisor Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Active Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Active Supervision Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship" },
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
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Active Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Active Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["prepare", "ship"] },
    );

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-active-supervision" });
    await executeWorkflowRun(db, runId);
    const prepareStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "prepare") ?? null);
    expect(prepareStepRun?.issueId).toBeTruthy();

    await issueService(db).update(prepareStepRun!.issueId!, { status: "done" });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(result.missions[0]?.recommendations.map((recommendation) => recommendation.type)).toContain("dispatch_missing_step");
    expect(result.missions[0]?.appliedActions.map((action) => action.type)).toContain("dispatch_missing_step");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const shipStepRun = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(shipStepRun?.issueId).toBeTruthy();
    const [shipIssue] = await db.select().from(issues).where(eq(issues.id, shipStepRun!.issueId!)).limit(1);
    expect(shipIssue.status).toBe("todo");
  });

  it("keeps retry replan and escalation recommendations as owner actions, not automatic changes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Unsafe Supervision",
      issuePrefix: `US${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Unsafe Supervisor Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Unsafe Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unsafe Supervision Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare" },
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
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Unsafe Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Unsafe Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["prepare"] },
    );
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "blocked",
      title: "Unsafe Supervision Workflow: Prepare",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "prepare",
      issueId: blockedIssue.id,
      status: "failed",
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const recommendations = result.missions[0]?.recommendations.map((recommendation) => recommendation.type) ?? [];
    expect(recommendations).toContain("retry_failed_step_if_safe");
    expect(recommendations).toContain("request_replan");
    expect(recommendations).toContain("escalate_blocked");
    expect(result.missions[0]?.appliedActions).toEqual([]);

    const [blockedIssueAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssue.id)).limit(1);
    expect(blockedIssueAfter.status).toBe("blocked");
    const [stepRunAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.issueId, blockedIssue.id)).limit(1);
    expect(stepRunAfter.status).toBe("failed");
  });

  it("cancels outstanding workflow execution issues when a workflow run is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-cancel" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Cancel",
      issuePrefix: `WC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Cancel Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Cancelable Workflow",
      steps: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship the work" },
      ],
    });

    const result = await workflowService.trigger(db, {
      companyId,
      workflowId: definition.id,
      triggeredBy: "manual",
    });

    expect(result.status).toBe("running");

    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId));
    const prepareStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "prepare");
    const shipStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(prepareStepRun?.issueId).toBeTruthy();
    expect(shipStepRun?.issueId).toBeNull();

    const cancelled = await workflowService.cancelRun(db, result.runId);
    expect(cancelled).toBe(true);

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("cancelled");

    const cancelledIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, prepareStepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(cancelledIssue).toMatchObject({
      status: "cancelled",
      originKind: "workflow_execution",
      originRunId: result.runId,
    });
    expect(cancelledIssue?.cancelledAt).toBeTruthy();

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(finalStepRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "prepare", status: "failed" }),
      expect.objectContaining({ stepId: "ship", status: "skipped" }),
    ]));
  });
});
