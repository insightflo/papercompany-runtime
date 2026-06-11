import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  workflowDelegations,
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
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepExecutor,
  syncWorkflowRunForIssue,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { registerNativeWorkflowToolResultEventHandlers } from "../services/workflow/tool-result-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow DAG tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("normalizeWorkflowStepsForExecution", () => {
  it("normalizes legacy plugin workflow step payloads for native DAG execution", () => {
    expect(
      normalizeWorkflowStepsForExecution([
        {
          id: "generate-infographic",
          title: "Tech Scout 교육만화 생성",
          tools: ["generate-tech-scout-knowledge-comic"],
          dependsOn: ["scout-and-report"],
        },
        {
          id: "send-telegram",
          title: "텔레그램으로 PNG 전송",
          toolName: "send-telegram",
          dependsOn: ["generate-infographic"],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "generate-infographic",
        name: "Tech Scout 교육만화 생성",
        agentId: "",
        dependencies: ["scout-and-report"],
        toolNames: ["generate-tech-scout-knowledge-comic"],
      }),
      expect.objectContaining({
        id: "send-telegram",
        name: "텔레그램으로 PNG 전송",
        agentId: "",
        dependencies: ["generate-infographic"],
        toolNames: ["send-telegram"],
      }),
    ]);
  });
});

describeEmbeddedPostgres("executeWorkflowRun issue lifecycle parity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-dag-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
    await db.delete(workflowDelegations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(pluginEntities);
    await db.delete(plugins);
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

  it("reconciles stuck running workflow runs using a Date cutoff", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stuck Workflow Company",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "stuck-workflow",
      stepsJson: [{ id: "step-1", name: "Step 1", agentId: "", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });

    const result = await workflowService.reconcile(db, 60);

    expect(result).toEqual({ recovered: 0, failed: 1 });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(stored?.status).toBe("failed");
    expect(stored?.completedAt).toBeInstanceOf(Date);
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
      description: expect.stringContaining(`workflowRunId: ${runId}`),
      status: "todo",
      assigneeAgentId: agentId,
      missionId: null,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    expect(createdIssue?.identifier).toMatch(/^WF[A-Z0-9]+-1$/);
    expect(createdIssue?.description).toContain(`workflowDefinitionId: ${workflowId}`);
    expect(createdIssue?.description).toContain("missionId: none");
    expect(createdIssue?.description).toContain(`stepId: ${stepId}`);
    expect(createdIssue?.description).toContain("dependencyStepIds: []");
    expect(createdIssue?.description).toContain("Treat issue ids from other missions or workflow runs as out of scope");
    expect(createdIssue?.description).toContain("Official workProduct contract:");
    expect(createdIssue?.description).toContain(`POST /api/issues/{issueId}/work-products`);

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

  it("wakes an existing todo workflow step issue when a run is resumed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "deliver-report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-resume" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Resume Workflow",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Resume Agent",
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
      title: "Resume Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Resume Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Deliver report",
          agentId,
          dependencies: [],
          description: "Deliver the report",
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
    const existingIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      status: "todo",
      title: "Resume Workflow: Deliver report",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId,
      issueId: existingIssue.id,
      status: "pending",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    const issueRows = await db.select().from(issues).where(eq(issues.originRunId, runId));
    expect(issueRows.map((issue) => issue.id)).toEqual([existingIssue.id]);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: existingIssue.id,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId,
      }),
      requestedByActorType: "system",
      requestedByActorId: `workflow:${workflowId}`,
      contextSnapshot: expect.objectContaining({
        issueId: existingIssue.id,
        taskId: existingIssue.id,
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        workflowStepId: stepId,
        stepId,
        source: "workflow.resume",
        wakeReason: "workflow_step_runnable",
      }),
    }));
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
      title: "[OVERSIGHT] tech-scout report 생성",
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
        name: "Synthesis Editor",
        role: "pm",
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
    expect(initial.completedAt).toBeNull();
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
    expect(afterPlan?.completedAt).toBeNull();

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

  it("advances dependent steps when a linked workflow step issue lost workflow origin metadata", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-originless-step" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Originless Workflow",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Originless Step Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
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
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesizeStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collectStepRun?.issueId).toBeTruthy();
    expect(synthesizeStepRun?.issueId).toBeNull();

    await db
      .update(issues)
      .set({
        originKind: "manual",
        originId: null,
        originRunId: null,
      })
      .where(eq(issues.id, collectStepRun!.issueId!));

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });
    const afterCollect = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(afterCollect?.status).toBe("running");

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedCollect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const progressedSynthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(progressedCollect?.status).toBe("completed");
    expect(progressedSynthesize?.issueId).toBeTruthy();

    const createdSynthesisIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedSynthesize!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdSynthesisIssue).toMatchObject({
      title: "Originless Step Workflow: Synthesize",
      assigneeAgentId: agentBId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
  });

  it("automatically advances dependent steps when a workflow issue is marked done", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-advance" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Auto Advance Workflow",
      issuePrefix: `AA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
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
      title: "Auto advance mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Auto Advance Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
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
    await executeWorkflowRun(db, runId);
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    expect(collectStepRun?.issueId).toBeTruthy();

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collect?.status).toBe("completed");
    expect(synthesize?.issueId).toBeTruthy();
    expect(synthesize?.status).toBe("pending");

    const [synthesisIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, synthesize!.issueId!));
    expect(synthesisIssue).toEqual(expect.objectContaining({
      title: "Auto Advance Workflow: Synthesize",
      status: "todo",
      assigneeAgentId: agentBId,
    }));
  });

  it("rejects completing mission oversight while workflow steps remain active", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Oversight Guard Workflow",
      issuePrefix: `OG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
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
      ownerAgentId: agentId,
      title: "Oversight guard mission",
      status: "active",
    });
    const issueSvc = issueService(db);
    const oversight = await issueSvc.create(companyId, {
      missionId,
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Oversight guard mission",
      status: "todo",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Oversight Guard Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(workflowStepRuns).values([
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "collect",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "synthesize",
        status: "pending",
      },
    ]);

    await expect(issueSvc.update(oversight.id, { status: "done" }))
      .rejects.toThrow(/Cannot complete mission oversight/);

    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversight.id));
    expect(storedOversight?.status).toBe("todo");
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

  it("resolves legacy plugin workflow step agentName to the company agent assignee", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-agent-name" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Agent Name Workflow",
      issuePrefix: `WN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "terminated",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: agentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          title: "TechCrunch AI 데일리 브리핑",
          type: "agent",
          agentName: "Technology Research Agent",
          tools: ["techcrunch-ai-scan"],
          dependsOn: [],
          description: "Collect AI funding and product news.",
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

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .limit(1);
    expect(stepRun).toMatchObject({
      stepId: "collect-ai-news-evidence",
      status: "pending",
    });
    expect(stepRun?.issueId).toBeTruthy();

    const [createdIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .limit(1);
    expect(createdIssue).toMatchObject({
      title: "tech-ai-news: TechCrunch AI 데일리 브리핑",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    const contract = await workflowService.getStepExecutionContractForIssue(db, createdIssue!.id);
    expect(contract).toMatchObject({
      workflowRunId: runId,
      stepId: "collect-ai-news-evidence",
      stepName: "TechCrunch AI 데일리 브리핑",
      toolNames: [],
    });
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      reason: "issue_assigned",
    }));
  });

  it("dispatches issue-less tool steps and advances dependent agent steps after tool result", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-tool-agent" });
    setWorkflowToolStepExecutor(executeToolStep);

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
          toolArgs: { query: "mission context" },
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
      status: "running",
    });
    expect(toolStep?.startedAt).toBeTruthy();
    expect(toolStep?.completedAt).toBeNull();
    expect(agentStep?.issueId).toBeNull();
    expect(agentStep?.status).toBe("pending");
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      workflowRunId: runId,
      workflowId,
      stepId: "fetch-context",
      stepRunId: toolStep!.id,
      toolName: "search-docs",
      args: { query: "mission context" },
    }));

    const afterToolResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: toolStep!.id,
      success: true,
    });
    expect(afterToolResult?.status).toBe("running");

    const updatedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const completedToolStep = updatedStepRuns.find((stepRun) => stepRun.stepId === "fetch-context");
    const launchedAgentStep = updatedStepRuns.find((stepRun) => stepRun.stepId === "summarize");
    expect(completedToolStep).toMatchObject({
      issueId: null,
      status: "completed",
    });
    expect(completedToolStep?.completedAt).toBeTruthy();
    expect(launchedAgentStep?.issueId).toBeTruthy();
    expect(launchedAgentStep?.status).toBe("pending");

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

  it("injects workflow runDate into issue-less tool step args without overriding explicit dates", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Dated Tool Workflow",
      issuePrefix: `WD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Dated Tool Workflow",
      stepsJson: [
        {
          id: "generate-infographic",
          name: "Generate infographic",
          agentId: "",
          dependencies: [],
          toolNames: ["generate-tech-scout-knowledge-comic"],
          toolArgs: { promptOnly: true },
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: [],
          toolNames: ["send-telegram"],
          toolArgs: { date: "2026-06-10", techScoutDaily: true },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-11",
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    expect(executeToolStep).toHaveBeenCalledTimes(2);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "generate-infographic",
      args: { promptOnly: true, date: "2026-06-11" },
    }));
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "send-telegram",
      args: { date: "2026-06-10", techScoutDaily: true },
    }));
  });

  it("completes all-tool workflows from tool execution results without creating issues", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    setWorkflowToolStepExecutor(executeToolStep);

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

    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");

    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "fetch", issueId: null, status: "running" }),
        expect.objectContaining({ stepId: "extract", issueId: null, status: "pending" }),
      ]),
    );
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenLastCalledWith(expect.objectContaining({
      stepId: "fetch",
      toolName: "search-docs",
    }));

    const fetchStep = stepRuns.find((stepRun) => stepRun.stepId === "fetch")!;
    const fetchRequest = executeToolStep.mock.calls[0]?.[0] as { requestId: string };
    const wrongCompanyResult = await completeWorkflowToolStepFromResult(db, {
      companyId: randomUUID(),
      stepRunId: fetchStep.id,
      requestId: fetchRequest.requestId,
      workflowRunId: runId,
      stepId: "fetch",
      toolName: "search-docs",
      success: true,
    });
    const wrongRunResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: fetchStep.id,
      requestId: fetchRequest.requestId,
      workflowRunId: randomUUID(),
      stepId: "fetch",
      toolName: "search-docs",
      success: true,
    });
    const wrongStepResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: fetchStep.id,
      requestId: fetchRequest.requestId,
      workflowRunId: runId,
      stepId: "wrong-step",
      toolName: "search-docs",
      success: true,
    });
    expect(wrongCompanyResult).toBeNull();
    expect(wrongRunResult).toBeNull();
    expect(wrongStepResult).toBeNull();
    expect(await db
      .select({ status: workflowStepRuns.status })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, fetchStep.id))
      .then((rows) => rows[0]?.status))
      .toBe("running");

    const afterFetch = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: fetchStep.id,
      requestId: fetchRequest.requestId,
      workflowRunId: runId,
      stepId: "fetch",
      toolName: "search-docs",
      success: true,
    });
    expect(afterFetch?.status).toBe("running");
    expect(executeToolStep).toHaveBeenCalledTimes(2);
    expect(executeToolStep).toHaveBeenLastCalledWith(expect.objectContaining({
      stepId: "extract",
      toolName: "extract-facts",
    }));

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const extractStep = stepRuns.find((stepRun) => stepRun.stepId === "extract")!;
    const extractRequest = executeToolStep.mock.calls[1]?.[0] as { requestId: string };
    const afterExtract = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: extractStep.id,
      requestId: extractRequest.requestId,
      workflowRunId: runId,
      stepId: "extract",
      toolName: "extract-facts",
      success: true,
    });
    expect(afterExtract?.status).toBe("completed");

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "fetch", issueId: null, status: "completed" }),
        expect.objectContaining({ stepId: "extract", issueId: null, status: "completed" }),
      ]),
    );
    expect(stepRuns.every((stepRun) => stepRun.startedAt && stepRun.completedAt)).toBe(true);

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(0);

    let workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.completedAt).toBeTruthy();

    const canonicalCompletedAt = new Date("2026-06-10T08:00:00.000Z");
    await db
      .update(workflowRuns)
      .set({ completedAt: canonicalCompletedAt })
      .where(eq(workflowRuns.id, runId));

    const duplicateExtract = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: extractStep.id,
      requestId: extractRequest.requestId,
      workflowRunId: runId,
      stepId: "extract",
      toolName: "extract-facts",
      success: true,
    });
    expect(duplicateExtract?.status).toBe("completed");
    expect(executeToolStep).toHaveBeenCalledTimes(2);

    workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.completedAt?.toISOString()).toBe(canonicalCompletedAt.toISOString());

    const failedWorkflowId = randomUUID();
    const failedRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: failedWorkflowId,
      companyId,
      name: "Tool Failure Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-data"],
        },
        {
          id: "publish",
          name: "Publish",
          agentId: "",
          dependencies: ["collect"],
          toolNames: ["publish-data"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: failedRunId,
      workflowId: failedWorkflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    await executeWorkflowRun(db, failedRunId);
    const failedWorkflowInitialSteps = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, failedRunId));
    const collectStep = failedWorkflowInitialSteps.find((stepRun) => stepRun.stepId === "collect")!;
    const collectRequest = executeToolStep.mock.calls[2]?.[0] as { requestId: string };

    const failedResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: collectStep.id,
      requestId: collectRequest.requestId,
      workflowRunId: failedRunId,
      stepId: "collect",
      toolName: "collect-data",
      success: false,
      stderr: "tool exploded",
      exitCode: 1,
      error: "Tool failed",
    });
    expect(failedResult?.status).toBe("failed");
    expect(failedResult?.error).toBe("One or more workflow steps failed");
    expect(failedResult?.stepRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "collect", status: "failed" }),
      expect.objectContaining({ stepId: "publish", status: "skipped" }),
    ]));

    const failedCollectStep = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, collectStep.id))
      .then((rows) => rows[0]);
    expect(failedCollectStep?.lastDispatchErrorSummary).toBe("Tool failed");
    expect(failedCollectStep?.metadata).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        requestId: collectRequest.requestId,
        toolName: "collect-data",
        success: false,
        stderr: "tool exploded",
        exitCode: 1,
        error: "Tool failed",
      }),
    }));
  });

  it("advances native workflow steps from the tool-registry plugin result event", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    const eventBus = createPluginEventBus();

    setWorkflowToolStepExecutor(executeToolStep);
    registerNativeWorkflowToolResultEventHandlers(db, eventBus);

    await db.insert(companies).values({
      id: companyId,
      name: "Native Event Workflow Company",
      issuePrefix: `NE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Native Event Tool Workflow",
      stepsJson: [
        {
          id: "fetch",
          name: "Fetch",
          agentId: "",
          dependencies: [],
          toolNames: ["fetch-context"],
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

    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");
    expect(executeToolStep).toHaveBeenCalledTimes(1);

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const dispatched = executeToolStep.mock.calls[0]?.[0] as { requestId: string };

    const result = await eventBus.emit({
      eventId: randomUUID(),
      eventType: "plugin.insightflo.tool-registry.tool-execution-result",
      companyId,
      occurredAt: new Date().toISOString(),
      actorType: "plugin",
      actorId: "insightflo.tool-registry",
      payload: {
        requestId: dispatched.requestId,
        stepRunId: stepRun!.id,
        workflowRunId: runId,
        stepId: "fetch",
        toolName: "fetch-context",
        success: true,
        stdout: "event ok",
        exitCode: 0,
      },
    });
    expect(result.errors).toEqual([]);

    const storedStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRun!.id))
      .then((rows) => rows[0]);
    expect(storedStepRun?.status).toBe("completed");
    expect(storedStepRun?.metadata).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        requestId: dispatched.requestId,
        toolName: "fetch-context",
        success: true,
        stdout: "event ok",
        exitCode: 0,
      }),
    }));

    const storedRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0]);
    expect(storedRun?.status).toBe("completed");
    expect(storedRun?.completedAt).toBeTruthy();
  });

  it("delegates native workflow steps to another company and resumes with copied workProducts", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-delegation-target" });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Company",
        issuePrefix: `SC${sourceCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Target Company",
        issuePrefix: `TC${targetCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId: sourceCompanyId,
        name: "Source Synthesizer",
        role: "Synthesis",
        adapter: "mock",
        adapterConfig: {},
        status: "active",
      },
      {
        id: targetAgentId,
        companyId: targetCompanyId,
        name: "Target Researcher",
        role: "Research",
        adapter: "mock",
        adapterConfig: {},
        status: "active",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId: sourceCompanyId,
      name: "Cross Company Workflow",
      stepsJson: [
        {
          id: "request-research",
          name: "Request Research",
          agentId: "",
          dependencies: [],
          toolNames: ["delegate_to_company"],
          toolArgs: {
            targetCompanyId,
            targetAssigneeAgentId: targetAgentId,
            title: "Research delegated input",
            description: "Produce the research artifact for the source workflow.",
          },
        },
        {
          id: "synthesize",
          name: "Synthesize",
          agentId: sourceAgentId,
          dependencies: ["request-research"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId: sourceCompanyId,
      triggeredBy: "system",
      status: "pending",
    });

    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");

    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const delegateStep = stepRuns.find((stepRun) => stepRun.stepId === "request-research")!;
    const synthesizeStep = stepRuns.find((stepRun) => stepRun.stepId === "synthesize")!;
    expect(delegateStep).toMatchObject({ status: "running" });
    expect(delegateStep.issueId).toBeTruthy();
    expect(synthesizeStep).toMatchObject({ status: "pending", issueId: null });

    const [delegation] = await db
      .select()
      .from(workflowDelegations)
      .where(eq(workflowDelegations.sourceWorkflowStepRunId, delegateStep.id));
    expect(delegation).toMatchObject({
      sourceCompanyId,
      targetCompanyId,
      status: "active",
    });
    expect(delegation.sourceIssueId).toBe(delegateStep.issueId);
    expect(delegation.targetIssueId).toBeTruthy();

    const [targetIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, delegation.targetIssueId));
    expect(targetIssue).toMatchObject({
      companyId: targetCompanyId,
      assigneeAgentId: targetAgentId,
      status: "todo",
      originKind: "workflow_delegation_target",
      originId: delegateStep.id,
    });

    await db.insert(issueWorkProducts).values({
      companyId: targetCompanyId,
      issueId: targetIssue.id,
      type: "report",
      provider: "local",
      externalId: "target-report.html",
      title: "Target research report",
      status: "ready",
      reviewState: "approved",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Delegated research is complete.",
      metadata: { path: "/tmp/target-report.html" },
    });

    const updatedTarget = await issueService(db).update(targetIssue.id, { status: "done" });
    expect(updatedTarget?.status).toBe("done");

    const [completedDelegation] = await db
      .select()
      .from(workflowDelegations)
      .where(eq(workflowDelegations.id, delegation.id));
    expect(completedDelegation.status).toBe("completed");
    expect(completedDelegation.completedAt).toBeTruthy();

    const sourceProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, delegation.sourceIssueId!));
    expect(sourceProducts).toEqual([
      expect.objectContaining({
        companyId: sourceCompanyId,
        issueId: delegation.sourceIssueId,
        provider: "delegated",
        externalId: `delegated:${sourceProducts[0]!.metadata && (sourceProducts[0]!.metadata as any).delegatedFrom.workProductId}`,
        title: "Target research report",
        isPrimary: true,
      }),
    ]);
    expect(sourceProducts[0]!.metadata).toMatchObject({
      delegatedFrom: {
        companyId: targetCompanyId,
        issueId: targetIssue.id,
      },
      originalProvider: "local",
      originalExternalId: "target-report.html",
    });

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const completedDelegateStep = stepRuns.find((stepRun) => stepRun.stepId === "request-research")!;
    const launchedSynthesizeStep = stepRuns.find((stepRun) => stepRun.stepId === "synthesize")!;
    expect(completedDelegateStep).toMatchObject({ status: "completed", issueId: delegation.sourceIssueId });
    expect(launchedSynthesizeStep.issueId).toBeTruthy();
    expect(launchedSynthesizeStep.status).toBe("pending");

    const [synthesisIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, launchedSynthesizeStep.issueId!));
    expect(synthesisIssue.description).toContain("Dependency issue inputs:");
    expect(synthesisIssue.description).toContain("Target research report [report/ready]");
    expect(synthesisIssue.description).toContain("delegated:");
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
    const supervisionCommentBody = commentsAfterSupervision.map((comment) => comment.body).join("\n");
    expect(supervisionCommentBody).toContain("Mission owner supervision diagnosis");
    expect(supervisionCommentBody).toContain("Governance thread evidence:");
    expect(supervisionCommentBody).toContain("Workflow step reached terminal status failed.");
    expect(supervisionCommentBody).toContain("workflow_step_failed: Workflow step failed");
    expect(supervisionCommentBody).not.toContain("wake_agent");
  });

  it("reactivates skipped downstream steps when a failed prerequisite issue is reopened", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-reactivate" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Reactivation",
      issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Reactivation Agent",
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
      title: "Reactivation Workflow Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Reactivation Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId, dependencies: ["collect"], description: "Synthesize evidence" },
        { id: "validate", name: "Validate", agentId, dependencies: ["synthesize"], description: "Validate synthesis" },
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
    const collectStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "collect") ?? null);

    const issueSvc = issueService(db);
    await issueSvc.update(collectStepRun!.issueId!, { status: "blocked" });
    await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);

    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("failed");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.status).toBe("skipped");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.status).toBe("skipped");

    await issueSvc.update(collectStepRun!.issueId!, { status: "todo" });
    const reopened = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(reopened?.status).toBe("running");

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.issueId).toBeNull();
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.issueId).toBeNull();

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });
    const progressed = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(progressed?.status).toBe("running");

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const synthesizeStepRun = stepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    const validateStepRun = stepRuns.find((stepRun) => stepRun.stepId === "validate");
    expect(synthesizeStepRun?.status).toBe("pending");
    expect(synthesizeStepRun?.issueId).toBeTruthy();
    expect(validateStepRun?.status).toBe("pending");
    expect(validateStepRun?.issueId).toBeNull();
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
    expect(commentsAfterSignatureDedupe.length).toBeGreaterThanOrEqual(2);
  });

  it("observes stale todo issues whose only execution run failed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const oldCreatedAt = new Date(Date.now() - 10 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Failed Todo Supervision",
      issuePrefix: `FT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Failed Todo Supervisor Agent",
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
      title: "Failed Todo Supervision Mission",
      status: "active",
      source: "workflow",
    });
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Failed Todo Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Failed Todo Supervision Workflow",
      {},
    );
    const staleIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "manual",
      status: "todo",
      title: "Run failed but issue still appears queued",
    });
    await db.update(issues).set({ createdAt: oldCreatedAt }).where(eq(issues.id, staleIssue.id));
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      issueId: staleIssue.id,
      status: "failed",
      errorCode: "adapter_failed",
      error: "access token could not be refreshed",
      exitCode: 1,
      createdAt: oldCreatedAt,
      startedAt: oldCreatedAt,
      finishedAt: new Date(oldCreatedAt.getTime() + 10_000),
    });

    const directSupervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(),
    });
    expect(directSupervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(directSupervision.findings.join("\n")).toContain("stale_todo_after_failed_run");
    expect(directSupervision.recommendations.map((recommendation) => recommendation.type)).toEqual(expect.arrayContaining(["retry_unit_if_safe", "request_replan"]));

    const activeSupervision = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(activeSupervision.missionIds).toContain(missionId);
    expect(activeSupervision.missions[0]?.findings.join("\n")).toContain("stale_todo_after_failed_run");
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
    expect(result.missions[0]?.recommendations.map((recommendation) => recommendation.type)).not.toContain("dispatch_missing_step");
    expect(result.missions[0]?.appliedActions.map((action) => action.type)).not.toContain("dispatch_missing_step");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const shipStepRun = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(shipStepRun?.issueId).toBeTruthy();
    const [shipIssue] = await db.select().from(issues).where(eq(issues.id, shipStepRun!.issueId!)).limit(1);
    expect(shipIssue.status).toBe("todo");
  });

  it("includes aborted workflow missions in active owner supervision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Aborted Supervision",
      issuePrefix: `AS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Aborted Supervisor Agent",
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
      title: "Aborted Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Aborted Supervision Workflow",
      stepsJson: [
        { id: "publish", name: "Publish", agentId, dependencies: [], description: "Publish" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "failed",
      completedAt: new Date(),
    });
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Aborted Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Aborted Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["publish"] },
    );
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "blocked",
      title: "Aborted Supervision Workflow: Publish",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "publish",
      issueId: blockedIssue.id,
      status: "failed",
    });

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
    expect(result.missions[0]?.findings.join("\n")).toContain("blocked_without_replan");
    expect(result.missions[0]?.findings.join("\n")).toContain("failed_step_without_diagnosis");
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

  it("selects plugin-only active missions for owner supervision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin-only Supervision Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Supervisor Agent",
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
      title: "Plugin-only Workflow Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.supervision",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.supervision", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plugin-only active run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plugin Supervision Workflow",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
      },
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions.map((mission) => mission.missionId)).toContain(missionId);
  });


  it("diagnoses plugin failed units without linked issues as owner-decision findings", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();
    const pluginStepId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin failed unit supervision",
      issuePrefix: `PF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Failed Unit Supervisor",
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
      title: "Plugin failed unit mission",
      status: "active",
      source: "workflow",
    });
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Plugin failed unit mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Plugin Failed Unit Workflow",
    );
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.failed-unit",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.failed-unit", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plugin failed run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plugin Failed Unit Workflow",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
      },
    });
    await db.insert(pluginEntities).values({
      id: pluginStepId,
      pluginId,
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-step-run:${pluginStepId}`,
      title: "External publish",
      status: "failed",
      data: {
        workflowRunId: pluginRunId,
        stepId: "external-publish",
        status: "failed",
        companyId,
      },
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings.join("\n")).toContain("failed_unit_without_diagnosis");
    expect(missionResult?.findings.join("\n")).toContain(pluginStepId);
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "retry_unit_if_safe", safeToAutoApply: false }),
      expect.objectContaining({ type: "request_replan", safeToAutoApply: false }),
    ]));
    expect(missionResult?.appliedActions).toEqual([]);
  });

  it("observes active plan required inputs, approval gates, rule mismatch, and plan drift without blocking", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plan drift supervision",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plan Drift Supervisor",
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
      title: "Plan drift mission",
      status: "active",
      source: "workflow",
    });
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Plan drift mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Plan Drift Workflow",
    );
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.plan-drift",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.plan-drift", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plan drift run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plan Drift Workflow",
        companyId,
        missionId,
        status: "running",
      },
    });
    await db.update(missionPlanArtifacts)
      .set({
        refs: {
          schemaVersion: 2,
          executionUnits: [
            {
              sourceRef: { type: "plugin_workflow_run", id: pluginRunId },
              status: "pending",
              actionCategory: "external_cost",
            },
          ],
          ruleRefs: [{ key: "cost-approval", mode: "approval_gate" }],
        },
        requiredInputs: [{ key: "budget_limit", status: "requested" }],
        successCriteria: [],
        risks: [],
        steps: [],
      })
      .where(eq(missionPlanArtifacts.missionId, missionId));

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    const findings = missionResult?.findings.join("\n") ?? "";
    expect(findings).toContain("missing_required_input");
    expect(findings).toContain("approval_required");
    expect(findings).toContain("rule_mismatch");
    expect(findings).not.toContain("plan_outdated");
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_approval", safeToAutoApply: false }),
    ]));
    expect(missionResult?.appliedActions).toEqual([]);

    const pluginStepId = randomUUID();
    await db.insert(pluginEntities).values({
      id: pluginStepId,
      pluginId,
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-step-run:${pluginStepId}`,
      title: "Unplanned step",
      status: "running",
      data: {
        workflowRunId: pluginRunId,
        stepId: "unplanned-step",
        status: "running",
        companyId,
      },
    });

    const changedResult = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    const changedMissionResult = changedResult.missions.find((entry) => entry.missionId === missionId);
    expect(changedMissionResult?.commented).toBe(true);
    expect(changedMissionResult?.findings.join("\n")).toContain("plan_outdated");
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

    const cancelled = await workflowService.cancelRun(db, { runId: result.runId, companyId });
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
