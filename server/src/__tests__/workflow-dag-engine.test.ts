import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
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

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

import { issueService } from "../services/issues.ts";
import { missionService } from "../services/missions.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepReadinessChecker,
  setWorkflowToolStepExecutor,
  syncWorkflowRunForIssue,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { registerNativeWorkflowToolResultEventHandlers } from "../services/workflow/tool-result-events.js";
import { reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";

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

  it("coerces graphWorkProductRequired to a strict boolean (legacy string absorbed, default false)", () => {
    const normalized = normalizeWorkflowStepsForExecution([
      { id: "producer", graphWorkProductRequired: true },
      { id: "producer-legacy-string", graphWorkProductRequired: "true" },
      { id: "validator", graphWorkProductRequired: false },
      { id: "unset" },
      { id: "garbage-string", graphWorkProductRequired: "false" },
    ]);
    expect(normalized.map((s) => s.graphWorkProductRequired)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("normalizes workflow graph execution controls into the native runtime contract", () => {
    expect(
      normalizeWorkflowStepsForExecution([
        {
          id: "report",
          title: "Market report",
          type: "agent",
          graphConcurrencyKey: " market-report ",
          graphConcurrencyLimit: "2",
          graphPriority: "HIGH",
          graphCacheEnabled: "true",
          graphCacheTtlSeconds: "600",
          graphDeleteAfterUse: true,
        },
        {
          id: "publish",
          title: "Publish",
          dependsOn: ["report"],
          executionControls: {
            concurrencyKey: "publisher",
            concurrencyLimit: 1,
            priority: "critical",
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "report",
        name: "Market report",
        dependencies: [],
        executionControls: {
          concurrencyKey: "market-report",
          concurrencyLimit: 2,
          priority: "high",
          cacheEnabled: true,
          cacheTtlSeconds: 600,
          deleteAfterUse: true,
        },
      }),
      expect.objectContaining({
        id: "publish",
        name: "Publish",
        dependencies: ["report"],
        executionControls: {
          concurrencyKey: "publisher",
          concurrencyLimit: 1,
          priority: "critical",
        },
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
    setWorkflowToolStepReadinessChecker(null);
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

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toHaveLength(1);
    expect(result[0]?.action).toBe("recovered");
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(stored?.status).toBe("failed");
    expect(stored?.completedAt).toBeInstanceOf(Date);
  });

  it("does not fail pending downstream steps while a linked workflow issue is still active", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Active Workflow Company",
      issuePrefix: `AW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Worker",
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "active-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
      ],
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "AW-1",
      title: "Collect",
      status: "in_progress",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect",
        issueId,
        status: "running",
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "synthesize",
        status: "pending",
      },
    ]);

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toEqual([
      expect.objectContaining({
        runId,
        action: "skipped",
        reason: "Active workflow step execution is still running",
      }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
    expect(storedRun?.completedAt).toBeNull();
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "collect", status: "running" }),
      expect.objectContaining({ stepId: "synthesize", status: "pending", completedAt: null }),
    ]));
  });

  it("[P7] does not kill a stuck-looking run when a native control-flow loop is iterating (iteration_index > 0)", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Iterating Loop Company",
      issuePrefix: `IL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "iterating-loop",
      stepsJson: [
        { id: "produce", name: "Produce", type: "agent", agentId: "", dependencies: [] },
        { id: "qa", name: "QA", type: "agent", agentId: "", dependencies: ["produce"] },
      ],
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
    // produce completed + loop fired once(iteration_index=1); qa pending(no active issue/heartbeat).
    // → activeStep 검사엔 안 걸리지만 iteration_index>0 로 60min kill 면제.
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", status: "completed", iterationIndex: 1, startedAt: new Date("2020-01-01T00:00:00.000Z"), completedAt: new Date("2020-01-01T00:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa", status: "pending" },
    ]);

    const result = await reconcileStuckWorkflowRuns(db, 60);
    expect(result).toEqual([
      expect.objectContaining({ runId, action: "skipped", reason: expect.stringContaining("iterating") }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
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

  it("adds QA request-changes back-edges to reusable workflow definitions at create time", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow QA Loop Company",
      issuePrefix: `QL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Reusable QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(definition.steps.find((step) => step.id === "validate-report")?.conditionalDependencies).toBeUndefined();
  });

  it("preserves author-defined QA back-edges instead of replacing their loop cap", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Explicit Loop Company",
      issuePrefix: `EL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Explicit QA Loop Workflow",
      steps: [
        {
          id: "produce-report",
          name: "Produce report",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 }],
        },
        { id: "validate-report", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 },
    ]);
  });

  it("adds QA request-changes back-edges when reusable workflow definitions are updated", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Update Loop Company",
      issuePrefix: `UL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Updated QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
      ],
    });
    const updated = await workflowService.updateDefinition(db, definition.id, {
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(updated?.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });

  it("rejects new workflow tool references when the tool system is unavailable", async () => {
    const companyId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin is not installed.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Toolless Workflow",
      issuePrefix: `TL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Unavailable Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin is not installed.");
  });

  it("rejects new workflow tool references that are not selectable", async () => {
    const companyId = randomUUID();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Missing Tool Workflow",
      issuePrefix: `MT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Missing Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow('Workflow tool "collect-data" is unavailable.');
  });

  it("preflights existing tool workflows before creating a new run", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin worker is not running.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Existing Tool Workflow",
      issuePrefix: `ET${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Existing Tool Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          dependencies: [],
          toolNames: ["collect-data"],
        },
      ],
    });

    await expect(workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      triggerSource: "manual",
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin worker is not running.");

    const runs = await db.select().from(workflowRuns);
    expect(runs).toEqual([]);
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
          name: "Draft {$date} plan",
          agentId,
          dependencies: [],
          description: "Prepare the {$runDate} implementation plan",
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-12",
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
      title: "Draft 2026-06-12 plan",
      description: expect.stringContaining(`workflowRunId: ${runId}`),
      status: "todo",
      assigneeAgentId: agentId,
      missionId: null,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    expect(createdIssue?.identifier).toMatch(/^WF[A-Z0-9]+-1$/);
    expect(createdIssue?.description).toContain("Prepare the 2026-06-12 implementation plan");
    expect(createdIssue?.description).toContain(`workflowDefinitionId: ${workflowId}`);
    expect(createdIssue?.description).toContain("missionId: none");
    expect(createdIssue?.description).toContain(`stepId: ${stepId}`);
    expect(createdIssue?.description).toContain("dependencyStepIds: []");
    expect(createdIssue?.description).toContain("Treat issue ids from other missions or workflow runs as out of scope");
    // planning step is NOT a workProduct producer (graphWorkProductRequired unset) →
    // dag-engine must NOT inject the deliverable/registration contract.
    expect(createdIssue?.description).not.toContain("Deliverable output (use exactly this directory)");
    expect(createdIssue?.description).not.toContain("WorkProduct registration contract:");
    expect(createdIssue?.description).not.toContain("[ARTIFACT]:");
    expect(createdIssue?.description).not.toContain("POST /api/issues/{issueId}/work-products");

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
      title: "Draft 2026-06-12 plan",
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

  it("injects deliverable + registration contract only for workProduct steps (graphWorkProductRequired=true)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "produce-report";
    const workProductRoot = `/tmp/wf-workproduct-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-workproduct" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip WorkProduct",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer Agent",
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
      title: "WorkProduct mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Producer Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Produce report",
          agentId,
          dependencies: [],
          description: "Write the report file.",
          graphWorkProductRequired: true,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-12",
    });

    await executeWorkflowRun(db, runId);

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

    // graphWorkProductRequired=true → dag-engine injects the full contract.
    expect(createdIssue?.description).toContain("Deliverable output (use exactly this directory):");
    expect(createdIssue?.description).toContain(workProductRoot);
    expect(createdIssue?.description).toContain("WorkProduct registration contract:");
    expect(createdIssue?.description).toContain("[ARTIFACT]:");
    expect(createdIssue?.description).toContain("For QA/validator steps"); // QA guidance always present
    expect(createdIssue?.description).not.toContain("POST /api/issues/{issueId}/work-products");
  });

  it("writes QA step grading criteria to a rubric markdown file and gives the QA agent only that path", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-qa-rubric-${companyId}`;
    const criteriaText = [
      "Report Validator step.",
      "Check Top25 rank coverage, duplicate/missing entries, source URL presence,",
      "collection timestamp, fallback notes, confidence labels, and whether any item should be excluded from synthesis.",
      "Return PASS or REQUEST_CHANGES with exact gaps.",
    ].join(" ");

    heartbeatWakeup.mockResolvedValue({ id: "queued-qa-rubric" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip QA Rubric",
      issuePrefix: `QR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "Producer Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Agent",
        role: "validator",
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
      ownerAgentId: producerAgentId,
      title: "QA rubric mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "QA Rubric Workflow",
      stepsJson: [
        {
          id: "collect-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write evidence.json.",
          graphWorkProductRequired: true,
        },
        {
          id: "audit-evidence",
          name: "Audit evidence",
          agentId: qaAgentId,
          dependencies: ["collect-evidence"],
          description: criteriaText,
          graphWorkProductRequired: false,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-25",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const producerStepRun = stepRuns.find((row) => row.stepId === "collect-evidence")!;
    const producerIssueId = producerStepRun.issueId!;

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      },
    });
    await issueService(db).update(producerIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, producerIssueId);

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qaStepRun = stepRuns.find((row) => row.stepId === "audit-evidence")!;
    expect(qaStepRun.issueId).toBeTruthy();

    const [qaIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, qaStepRun.issueId!));

    expect(qaIssue.description).toContain("QA grading rubric:");
    expect(qaIssue.description).toContain("qa-rubric.md");
    expect(qaIssue.description).not.toContain("Check Top25 rank coverage");
    expect(qaIssue.description).not.toContain("collection timestamp, fallback notes");
    expect(qaIssue.description).not.toContain("Deliverable output (use exactly this directory):");
    expect(qaIssue.description).not.toContain("[ARTIFACT]:");

    const rubricPath = qaIssue.description.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    expect(fs.existsSync(rubricPath!)).toBe(true);
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Check Top25 rank coverage");
    expect(rubric).toContain("Return PASS or REQUEST_CHANGES with exact gaps.");
    expect(rubric).toContain(`workflowRunId: ${runId}`);
    expect(rubric).toContain("collect-evidence");
    expect(rubric).toContain("evidence.json");
  });

  it("copies execution controls into workflow step run metadata when launching a step", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-execution-controls" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Execution Controls",
      issuePrefix: `EC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "Execution Controls Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Report",
          agentId,
          dependencies: [],
          graphConcurrencyKey: "market-report",
          graphConcurrencyLimit: 2,
          graphPriority: "high",
          graphCacheEnabled: true,
          graphCacheTtlSeconds: 600,
          graphDeleteAfterUse: true,
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
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRun?.metadata).toEqual({
      executionControls: {
        concurrencyKey: "market-report",
        concurrencyLimit: 2,
        priority: "high",
        cacheEnabled: true,
        cacheTtlSeconds: 600,
        deleteAfterUse: true,
      },
      graphWorkProductRequired: false,
    });
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

  it("restores a released workflow step issue assignee before waking it on resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "qa-report";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-restored-assignee" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Released Workflow",
      issuePrefix: `RL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA Agent",
      role: "qa",
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
      title: "Released QA Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Released QA Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "QA report",
          agentId,
          dependencies: [],
          description: "Validate the report",
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
      assigneeAgentId: null,
      missionId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      status: "todo",
      title: "Released QA Workflow: QA report",
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
    const [restoredIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, existingIssue.id));
    expect(restoredIssue?.assigneeAgentId).toBe(agentId);
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
    }));
  });

  it("blocks downstream tool steps when a validator issue is done with REQUEST_CHANGES", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Gate",
      issuePrefix: `VG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
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
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      body: [
        "REQUEST_CHANGES — Artifact Validation Result",
        "",
        "- Hallucinated label remains in the PNG.",
        "- Coverage is incomplete; do not deliver to Telegram.",
      ].join("\n"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")).toMatchObject({
      status: "failed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "pending",
      issueId: null,
    });
  });

  it("requeues a blocked validator issue when an upstream dependency completes after REQUEST_CHANGES", async () => {
    const companyId = randomUUID();
    const synthAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const synthIssueId = randomUUID();
    const validatorIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-validator-recheck" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recheck",
      issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: synthAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
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
      ownerAgentId,
      title: "Daily AI news validator recheck",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "synthesize-ai-news-note",
          name: "Synthesize TechCrunch AI note draft",
          agentId: synthAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-note",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: ["synthesize-ai-news-note"],
        },
        {
          id: "lead-ai-news-approval",
          name: "Lead approval for TechCrunch AI note",
          agentId: ownerAgentId,
          dependencies: ["validate-ai-news-note"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-18T05:06:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: synthIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Synthesize TechCrunch AI note draft",
        status: "done",
        assigneeAgentId: synthAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
        status: "blocked",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-18T05:37:09.000Z"),
      body: "Decision: REQUEST_CHANGES\nThree source-bound fidelity fixes are required on the synthesis issue.",
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "synthesize-ai-news-note",
        issueId: synthIssueId,
        status: "completed",
        startedAt: new Date("2026-06-18T05:50:00.000Z"),
        completedAt: new Date("2026-06-18T05:55:56.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T05:31:00.000Z"),
        completedAt: new Date("2026-06-18T05:37:09.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "lead-ai-news-approval",
        issueId: null,
        status: "pending",
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, synthIssueId);

    expect(result?.status).toBe("running");
    const [validatorIssue] = await db.select().from(issues).where(eq(issues.id, validatorIssueId));
    expect(validatorIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: validatorAgentId,
      startedAt: null,
      completedAt: null,
    });
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")).toMatchObject({
      status: "pending",
      issueId: validatorIssueId,
      startedAt: null,
      completedAt: null,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "lead-ai-news-approval")).toMatchObject({
      status: "pending",
      issueId: null,
    });
    expect(heartbeatWakeup).toHaveBeenCalledWith(validatorAgentId, expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: validatorIssueId,
        mutation: "workflow_resume",
        missionId,
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId: "validate-ai-news-note",
      }),
    }));
  });

  it("allows downstream steps after a newer validator heartbeat PASS supersedes an older REQUEST_CHANGES comment", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const passRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recovery",
      issuePrefix: `VR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:05:00.000Z"),
      completedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier validation failed.",
    });
    await db.insert(heartbeatRuns).values({
      id: passRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        result: "## Report Validator Verdict: **PASS**\n\nBoth requested fixes are verified.",
      },
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      finishedAt: new Date("2026-06-14T06:12:00.000Z"),
      createdAt: new Date("2026-06-14T06:11:00.000Z"),
      updatedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({
      workflowRunId: runId,
      stepId: "send-telegram",
      toolName: "send-telegram",
    }));
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")).toMatchObject({
      status: "completed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "running",
      issueId: null,
    });
  });

  it("ignores REQUEST_CHANGES comments from before the current validator execution window", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Requeued Recovery",
      issuePrefix: `VQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news requeued recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      completedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier execution failed before requeue.",
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:11:00.000Z"),
        completedAt: new Date("2026-06-14T06:12:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({
      workflowRunId: runId,
      stepId: "send-telegram",
      toolName: "send-telegram",
    }));
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")).toMatchObject({
      status: "completed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "running",
      issueId: null,
    });
  });

  // [목적] dag-engine 의 validation verdict 로딩 경로(loadLatestValidationVerdicts →
  //   readValidationVerdictFromHeartbeatResult → extractCodexTaskCompleteMessages) 가 heartbeat run 의
  //   resultJson.stdout(codex JSONL) 에서 REQUEST_CHANGES / PASS 를 읽는지 검증.
  //   comment 경로는 위 두 테스트가, codex stdout 경로는 아래 두 테스트가 담당한다.
  function buildCodexStdout(lines: unknown[]): string {
    return lines.map((line) => JSON.stringify(line)).join("\n");
  }

  it("blocks downstream tool steps when a validator heartbeat resultJson.stdout carries REQUEST_CHANGES via codex task_complete last_agent_message", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Validation Gate",
      issuePrefix: `CS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
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
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // validator heartbeat run: codex stdout(JSONL) 가 REQUEST_CHANGES verdict 를 싣는다.
    // task_complete 이벤트의 payload.last_agent_message 가 "REQUEST_CHANGES\n- ..." — extractCodexTaskCompleteMessages
    // 가 이를 추출하고 readValidationVerdictFromHeartbeatResult 가 request_changes 로 판정한다.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: { type: "agent_message", text: "Validating the artifact against source claims." },
          },
          {
            type: "task_complete",
            payload: {
              last_agent_message: "REQUEST_CHANGES\n- Hallucinated label remains in the PNG.\n- Coverage is incomplete; do not deliver to Telegram.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")).toMatchObject({
      status: "failed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "pending",
      issueId: null,
    });
  });

  it("allows downstream steps when a validator heartbeat resultJson.stdout carries PASS via codex item.completed agent_message", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Pass Gate",
      issuePrefix: `CP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
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
      ownerAgentId,
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // validator heartbeat run: codex stdout(JSONL) 가 PASS verdict 를 싣는다.
    // item.completed 이벤트의 item.type:"agent_message" / item.text 가 "PASS ..." — extractCodexTaskCompleteMessages
    // 가 이를 추출하고 readValidationVerdictFromHeartbeatResult 가 pass 로 판정한다.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "PASS — Both requested fixes are verified in the PNG; sources match.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({
      workflowRunId: runId,
      stepId: "send-telegram",
      toolName: "send-telegram",
    }));
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")).toMatchObject({
      status: "completed",
      issueId: validatorIssueId,
    });
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")).toMatchObject({
      status: "running",
      issueId: null,
    });
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
      runDate: "2026-06-12",
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
      title: "2026-06-12 tech-scout report 생성",
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

  it("uses workflow/company timezone, not UTC, for scheduled runDate and mission titles", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-timezone-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "KST Workflow Company",
      issuePrefix: `KST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "KST Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-morning",
      timezone: null,
      steps: [
        {
          id: "collect-market",
          name: "Collect market",
          agentId,
          dependencies: [],
        },
      ],
    });

    const result = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-11T22:30:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(result.claimed).toBe(true);

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.run!.runId))
      .limit(1);
    expect(run?.runDate).toBe("2026-06-12");

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);

    expect(mission?.title).toBe("2026-06-12 gazua-morning");
  });

  it("does not start another scheduled run that would duplicate issues in the same active workflow mission", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-scheduled-active-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Active Scheduled Mission Company",
      issuePrefix: `ASM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "gazua-macro-sentinel",
      timezone: "Asia/Seoul",
      schedule: "0 9-15 * * 1-5",
      steps: [
        {
          id: "report",
          name: "초보자용 매크로 리포트 생성",
          agentId,
          dependencies: [],
        },
      ],
    });

    const first = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T00:00:00.000Z"),
      timezone: "Asia/Seoul",
    });
    expect(first.claimed).toBe(true);

    const second = await workflowService.claimScheduledRun(db, {
      companyId,
      workflowId: definition.id,
      scheduledAt: new Date("2026-06-17T01:00:00.000Z"),
      timezone: "Asia/Seoul",
    });

    expect(second.claimed).toBe(false);
    expect(second.run).toBeNull();

    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, definition.id));
    expect(storedRuns).toHaveLength(1);

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, storedRuns[0]!.missionId!))
      .limit(1);
    expect(mission?.status).toBe("active");

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, mission!.id));
    expect(missionIssues.filter((issue) => issue.title === "초보자용 매크로 리포트 생성")).toHaveLength(1);
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

    const buildIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedBuild!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(buildIssue?.description).toContain("Dependency workProduct hard-stop:");
    expect(buildIssue?.description).toContain(`- plan: ${planIssue?.identifier ?? planIssue!.id} has no registered dependency workProduct.`);
    expect(buildIssue?.description).toContain("Do not infer dependency deliverables from guessed filesystem paths");

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

  // ---- Plan B: dependency ARTIFACT path injection ----
  // [목적] upstream 이 정식 workProduct 를 등록하지 않아도, producer 가 run output /
  // description / comment 에 남긴 명시적 `[ARTIFACT]: <절대경로>` 를 downstream input 에
  // 보조 evidence 로 주입하는지 검증한다.
  type PlanBStepDef = {
    id: string;
    name: string;
    agentId: string;
    dependencies: string[];
    description?: string;
  };

  async function executeDependencyWorkflow(opts: {
    companyId: string;
    companyName: string;
    missionId: string;
    workflowId: string;
    runId: string;
    agents: Array<{ id: string; name: string; role: string }>;
    steps: PlanBStepDef[];
  }): Promise<Record<string, typeof issues.$inferSelect>> {
    heartbeatWakeup.mockResolvedValue({ id: "plan-b-run" });
    await db.insert(companies).values({
      id: opts.companyId,
      name: opts.companyName,
      issuePrefix: `PB${opts.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      opts.agents.map((agent) => ({
        id: agent.id,
        companyId: opts.companyId,
        name: agent.name,
        role: agent.role,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(missions).values({
      id: opts.missionId,
      companyId: opts.companyId,
      ownerAgentId: opts.agents[0]!.id,
      title: opts.companyName,
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: opts.workflowId,
      companyId: opts.companyId,
      name: opts.companyName,
      stepsJson: opts.steps,
    });
    await db.insert(workflowRuns).values({
      id: opts.runId,
      workflowId: opts.workflowId,
      companyId: opts.companyId,
      missionId: opts.missionId,
      triggeredBy: "system",
      status: "pending",
    });
    await executeWorkflowRun(db, opts.runId);
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, opts.runId));
    const issuesByStep: Record<string, typeof issues.$inferSelect> = {};
    for (const stepRun of stepRuns) {
      if (!stepRun.issueId) continue;
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, stepRun.issueId))
        .then((rows) => rows[0] ?? null);
      if (issue) issuesByStep[stepRun.stepId] = issue;
    }
    return issuesByStep;
  }

  async function completeStepIssue(issueId: string) {
    await issueService(db).update(issueId, { status: "done" });
    await syncWorkflowRunForIssue(db, issueId);
  }

  async function getStepIssue(runId: string, stepId: string) {
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)))
      .then((rows) => rows[0] ?? null);
    if (!stepRun?.issueId) return null;
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId))
      .then((rows) => rows[0] ?? null);
  }

  // producer 가 heartbeat run output 에 `[ARTIFACT]:` 를 남긴 경우를 시뮬레이션.
  async function seedArtifactRun(opts: { companyId: string; agentId: string; issueId: string; artifactPath: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      issueId: opts.issueId,
      status: "succeeded",
      invocationSource: "automation",
      stdoutExcerpt: `Collect finished.\n[ARTIFACT]: ${opts.artifactPath}`,
      startedAt: new Date("2026-06-24T06:00:00.000Z"),
      finishedAt: new Date("2026-06-24T06:05:00.000Z"),
      createdAt: new Date("2026-06-24T06:00:00.000Z"),
      updatedAt: new Date("2026-06-24T06:05:00.000Z"),
    });
    return runId;
  }

  async function seedArtifactComment(opts: { companyId: string; agentId: string; issueId: string; artifactPath: string }) {
    await db.insert(issueComments).values({
      companyId: opts.companyId,
      issueId: opts.issueId,
      authorAgentId: opts.agentId,
      body: `Done — evidence collected.\n[ARTIFACT]: ${opts.artifactPath}`,
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("Plan B: injects producer-declared ARTIFACT path (run output) for single upstream without a registered workProduct", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "PlanB Single Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector", role: "engineer" },
        { id: agentBId, name: "Auditor", role: "pm" },
      ],
      steps: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "audit", name: "Audit", agentId: agentBId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/tech-scout/202606/tech_scout_20260624/evidence.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.collect!.id, artifactPath });
    await completeStepIssue(upstream.collect!.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain("artifactPaths (auxiliary, producer-declared `[ARTIFACT]:`)");
    expect(desc).toContain(artifactPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
    expect(countOccurrences(desc, "has no registered dependency workProduct.")).toBe(0);
  });

  it("Plan B: injects per-dependency ARTIFACT paths for multiple upstreams (run output + comment sources)", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const agentCId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "PlanB Multi Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector A1", role: "engineer" },
        { id: agentBId, name: "Collector A2", role: "engineer" },
        { id: agentCId, name: "Synthesizer", role: "pm" },
      ],
      steps: [
        { id: "a1", name: "Collect A1", agentId: agentAId, dependencies: [], description: "Collect A1" },
        { id: "a2", name: "Collect A2", agentId: agentBId, dependencies: [], description: "Collect A2" },
        { id: "b", name: "Synthesize", agentId: agentCId, dependencies: ["a1", "a2"], description: "Synthesize A1+A2" },
      ],
    });
    const a1Path = "/srv/papercompany/produced_work/a1/evidence_a1.json";
    const a2Path = "/srv/papercompany/produced_work/a2/evidence_a2.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.a1!.id, artifactPath: a1Path });
    await seedArtifactComment({ companyId, agentId: agentBId, issueId: upstream.a2!.id, artifactPath: a2Path });
    await completeStepIssue(upstream.a1!.id);
    await completeStepIssue(upstream.a2!.id);

    const synthIssue = await getStepIssue(runId, "b");
    expect(synthIssue).toBeTruthy();
    const desc = synthIssue!.description ?? "";
    expect(desc).toContain(a1Path);
    expect(desc).toContain(a2Path);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
    expect(countOccurrences(desc, "has no registered dependency workProduct.")).toBe(0);
  });

  it("Plan B: hard-stops only the dependency missing both workProduct and ARTIFACT, while injecting paths for the one that declared ARTIFACT", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const agentCId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "PlanB Partial Artifact",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector A1", role: "engineer" },
        { id: agentBId, name: "Collector A2", role: "engineer" },
        { id: agentCId, name: "Synthesizer", role: "pm" },
      ],
      steps: [
        { id: "a1", name: "Collect A1", agentId: agentAId, dependencies: [], description: "Collect A1" },
        { id: "a2", name: "Collect A2", agentId: agentBId, dependencies: [], description: "Collect A2" },
        { id: "b", name: "Synthesize", agentId: agentCId, dependencies: ["a1", "a2"], description: "Synthesize A1+A2" },
      ],
    });
    const a1Path = "/srv/papercompany/produced_work/a1/evidence_a1.json";
    // a1 은 ARTIFACT 선언, a2 는 workProduct 도 ARTIFACT 도 없음.
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.a1!.id, artifactPath: a1Path });
    await completeStepIssue(upstream.a1!.id);
    await completeStepIssue(upstream.a2!.id);

    const synthIssue = await getStepIssue(runId, "b");
    expect(synthIssue).toBeTruthy();
    const desc = synthIssue!.description ?? "";
    expect(desc).toContain(a1Path);
    expect(desc).toContain("Dependency workProduct hard-stop:");
    expect(countOccurrences(desc, "has no registered dependency workProduct.")).toBe(1);
    expect(desc).toContain(`- a2: ${upstream.a2!.identifier ?? upstream.a2!.id} has no registered dependency workProduct.`);
  });

  it("Plan B: ignores ARTIFACT paths declared on unrelated issues/comments outside the dependency scope", async () => {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "PlanB Scope Guard",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector", role: "engineer" },
        { id: agentBId, name: "Auditor", role: "pm" },
      ],
      steps: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "audit", name: "Audit", agentId: agentBId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const depPath = "/srv/papercompany/produced_work/collect/evidence.json";
    const orphanPath = "/srv/papercompany/produced_work/orphan/unrelated.json";
    // 의존성 collect issue 는 description 에 ARTIFACT 선언.
    const collectIssue = upstream.collect!;
    await db
      .update(issues)
      .set({ description: `${collectIssue.description ?? ""}\n[ARTIFACT]: ${depPath}` })
      .where(eq(issues.id, collectIssue.id));
    // 동일 company 의 무관 orphan issue 를 만들고 comment 에 ARTIFACT 남김 — dependency scope 밖.
    const orphanIssue = await issueService(db).create(companyId, {
      title: "Unrelated orphan issue",
      description: "Not part of this workflow run",
      status: "todo",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: orphanIssue.id,
      authorAgentId: agentAId,
      body: `Some unrelated work.\n[ARTIFACT]: ${orphanPath}`,
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
    await completeStepIssue(collectIssue.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain(depPath);
    expect(desc).not.toContain(orphanPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
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
      title: "Synthesize",
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
      title: "Synthesize",
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
      title: "Manual review",
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

    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
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
      title: "TechCrunch AI 데일리 브리핑",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    const contract = await workflowService.getStepExecutionContractForIssue(db, createdIssue!.id);
    expect(contract).toMatchObject({
      workflowRunId: runId,
      stepId: "collect-ai-news-evidence",
      stepName: "TechCrunch AI 데일리 브리핑",
      toolNames: ["techcrunch-ai-scan"],
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
      title: "Summarize",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
  });

  it("records issue-less tool dispatch failures on the step run", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    setWorkflowToolStepExecutor(vi.fn().mockRejectedValue(new Error("Tool Registry plugin is not installed.")));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Tool Failure Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Failure Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          dependencies: [],
          toolNames: ["collect-data"],
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

    expect(result.status).toBe("failed");
    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRun).toMatchObject({
      stepId: "collect",
      status: "failed",
      lastDispatchErrorSummary: "Tool Registry plugin is not installed.",
    });
    expect(stepRun?.metadata).toEqual(expect.objectContaining({
      toolInvocation: expect.objectContaining({
        toolName: "collect-data",
        dispatchError: "Tool Registry plugin is not installed.",
      }),
    }));
  });

  it("renders workflow runDate placeholders in issue-less tool step args without implicit date injection", async () => {
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
          toolArgs: { promptOnly: true, date: "{$runDate}", output: "report-{$date}.png" },
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: [],
          toolNames: ["send-telegram"],
          toolArgs: { date: "2026-06-10", techScoutDaily: true },
        },
        {
          id: "collect-market",
          name: "Collect market",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-morning"],
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
    expect(executeToolStep).toHaveBeenCalledTimes(3);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "generate-infographic",
      args: { promptOnly: true, date: "2026-06-11", output: "report-2026-06-11.png" },
    }));
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "send-telegram",
      args: { date: "2026-06-10", techScoutDaily: true },
    }));
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "collect-market",
      args: {},
    }));
  });

  it("reuses cached issue-less tool step results within the configured ttl", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Cached Tool Workflow",
      issuePrefix: `CT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Cached Tool Workflow",
      stepsJson: [
        {
          id: "fetch-market",
          name: "Fetch market",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-market"],
          toolArgs: { market: "KR", date: "{$runDate}" },
          executionControls: {
            cacheEnabled: true,
            cacheTtlSeconds: 600,
          },
        },
      ],
    });
    await db.insert(workflowRuns).values([
      {
        id: firstRunId,
        workflowId,
        companyId,
        triggeredBy: "system",
        status: "pending",
        runDate: "2026-06-12",
      },
      {
        id: secondRunId,
        workflowId,
        companyId,
        triggeredBy: "system",
        status: "pending",
        runDate: "2026-06-12",
      },
    ]);

    const first = await executeWorkflowRun(db, firstRunId);
    expect(first.status).toBe("running");
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    const [firstStepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, firstRunId));
    const firstRequest = executeToolStep.mock.calls[0]?.[0] as { requestId: string };
    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: firstStepRun!.id,
      requestId: firstRequest.requestId,
      workflowRunId: firstRunId,
      stepId: "fetch-market",
      toolName: "collect-market",
      success: true,
      stdout: "{\"items\":3}",
    });

    const second = await executeWorkflowRun(db, secondRunId);

    expect(second.status).toBe("completed");
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    const [secondStepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, secondRunId));
    expect(secondStepRun).toMatchObject({
      stepId: "fetch-market",
      status: "completed",
      issueId: null,
    });
    expect(secondStepRun?.metadata).toMatchObject({
      executionControls: {
        cacheEnabled: true,
        cacheTtlSeconds: 600,
      },
      cacheHit: {
        sourceStepRunId: firstStepRun!.id,
        toolName: "collect-market",
      },
      toolResult: {
        success: true,
        stdout: "{\"items\":3}",
      },
    });
  });

  it("dispatches higher-priority tool steps first and blocks lower-priority steps at the concurrency limit", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Priority Workflow",
      issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Priority Tool Workflow",
      stepsJson: [
        {
          id: "low-priority",
          name: "Low priority",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-low"],
          executionControls: {
            concurrencyKey: "market-data",
            concurrencyLimit: 1,
            priority: "low",
          },
        },
        {
          id: "high-priority",
          name: "High priority",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-high"],
          executionControls: {
            concurrencyKey: "market-data",
            concurrencyLimit: 1,
            priority: "high",
          },
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
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    expect(executeToolStep).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "high-priority",
      toolName: "collect-high",
    }));
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const high = stepRuns.find((stepRun) => stepRun.stepId === "high-priority");
    const low = stepRuns.find((stepRun) => stepRun.stepId === "low-priority");
    expect(high).toMatchObject({
      status: "running",
      issueId: null,
    });
    expect(low).toMatchObject({
      status: "pending",
      issueId: null,
    });
    expect(low?.metadata).toMatchObject({
      executionControls: {
        concurrencyKey: "market-data",
        concurrencyLimit: 1,
        priority: "low",
      },
      concurrencyBlocked: {
        concurrencyKey: "market-data",
        concurrencyLimit: 1,
        runningCount: 1,
      },
    });

    const highRequest = executeToolStep.mock.calls[0]?.[0] as { requestId: string };
    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: high!.id,
      requestId: highRequest.requestId,
      workflowRunId: runId,
      stepId: "high-priority",
      toolName: "collect-high",
      success: true,
    });

    expect(executeToolStep).toHaveBeenCalledTimes(2);
    expect(executeToolStep).toHaveBeenLastCalledWith(expect.objectContaining({
      stepId: "low-priority",
      toolName: "collect-low",
    }));
    const afterCapacityFreed = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const relaunchedLow = afterCapacityFreed.find((stepRun) => stepRun.stepId === "low-priority");
    expect(relaunchedLow).toMatchObject({
      status: "running",
      issueId: null,
    });
    expect(relaunchedLow?.metadata).toMatchObject({
      executionControls: {
        concurrencyKey: "market-data",
        concurrencyLimit: 1,
        priority: "low",
      },
      toolInvocation: {
        toolName: "collect-low",
      },
    });
    expect((relaunchedLow?.metadata as Record<string, unknown>).concurrencyBlocked).toBeUndefined();
  });

  it("deletes tool invocation and result payloads after use when retention control is enabled", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Retention Workflow",
      issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Retention Tool Workflow",
      stepsJson: [
        {
          id: "sensitive-tool",
          name: "Sensitive tool",
          agentId: "",
          dependencies: [],
          toolNames: ["collect-sensitive-market-data"],
          toolArgs: { token: "secret-token", market: "KR" },
          executionControls: {
            deleteAfterUse: true,
          },
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

    await executeWorkflowRun(db, runId);
    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const request = executeToolStep.mock.calls[0]?.[0] as { requestId: string };

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: stepRun!.id,
      requestId: request.requestId,
      workflowRunId: runId,
      stepId: "sensitive-tool",
      toolName: "collect-sensitive-market-data",
      success: true,
      stdout: "{\"token\":\"secret-token\",\"items\":3}",
      stderr: "debug secret-token",
      exitCode: 0,
    });

    const [completedStepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRun!.id));
    const metadata = completedStepRun?.metadata as Record<string, unknown>;

    expect(completedStepRun).toMatchObject({
      status: "completed",
    });
    expect(JSON.stringify(metadata)).not.toContain("secret-token");
    expect(metadata).toMatchObject({
      executionControls: {
        deleteAfterUse: true,
      },
      retentionDeleted: {
        deleteAfterUse: true,
        toolName: "collect-sensitive-market-data",
        success: true,
        exitCode: 0,
      },
    });
    expect(metadata.toolInvocation).toBeUndefined();
    expect(metadata.toolResult).toBeUndefined();
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
    expect(failedResult?.status).toBe("running");
    expect(failedResult?.error).toBeUndefined();
    expect(failedResult?.stepRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "collect", status: "failed" }),
      expect.objectContaining({ stepId: "publish", status: "pending" }),
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

  it("keeps dependent steps pending when a prerequisite execution issue fails", async () => {
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
    expect(failed?.status).toBe("running");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const prepare = finalStepRuns.find((stepRun) => stepRun.stepId === "prepare");
    const ship = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(prepare?.status).toBe("failed");
    expect(ship?.status).toBe("pending");
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

  it("keeps downstream steps pending when a prerequisite issue fails and resumes them when it recovers", async () => {
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
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.status).toBe("pending");

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

  it("resets legacy failed unlaunched downstream rows and launches them after prerequisites recover", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const prepareIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-legacy-downstream" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Legacy Downstream Recovery",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Recovery Agent",
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
      title: "Legacy Downstream Recovery Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Legacy Downstream Recovery Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "approve", name: "Approve", agentId, dependencies: ["prepare"], description: "Approve the work" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-06-18T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: prepareIssueId,
      companyId,
      missionId,
      title: "Legacy Downstream Recovery Workflow: Prepare",
      status: "done",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T06:00:00.000Z"),
      completedAt: new Date("2026-06-18T06:05:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "prepare",
        issueId: prepareIssueId,
        status: "completed",
        startedAt: new Date("2026-06-18T06:00:00.000Z"),
        completedAt: new Date("2026-06-18T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "approve",
        issueId: null,
        status: "failed",
        startedAt: null,
        completedAt: new Date("2026-06-18T06:06:00.000Z"),
        lastDispatchAttemptAt: null,
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, prepareIssueId);

    expect(result?.status).toBe("running");
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const approveStepRun = stepRows.find((stepRun) => stepRun.stepId === "approve");
    expect(approveStepRun?.status).toBe("pending");
    expect(approveStepRun?.issueId).toBeTruthy();
    const [approveIssue] = await db.select().from(issues).where(eq(issues.id, approveStepRun!.issueId!));
    expect(approveIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
  });

  it("[P2 control-flow] failure-gated step activates on predecessor failure, false-branch is skipped, and skip does not flap across syncs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const produceIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-control-flow-if" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow IF",
      issuePrefix: `CF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Control Flow Agent",
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
      title: "Conditional IF Mission",
      status: "active",
    });
    // Non-dynamic static DAG (이름이 tech-* 가 아니라 resetUnlaunchedTerminalStepRuns 가 실행됨 → sentinel 검증).
    // produce[root] → on-failure(when:failure), on-success(when:success). 둘 다 conditional edge 만 보유.
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Conditional IF Activation",
      stepsJson: [
        { id: "produce", name: "Produce", agentId, dependencies: [], description: "Produce artifact" },
        {
          id: "on-failure",
          name: "Recover on failure",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "produce", when: "failure" }],
          description: "Run only when produce fails",
        },
        {
          id: "on-success",
          name: "Continue on success",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "produce", when: "success" }],
          description: "Run only when produce succeeds",
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
      startedAt: new Date("2026-06-18T07:00:00.000Z"),
    });
    // produce 를 failed 상태로 seed (issue blocked → stepRun failed).
    await db.insert(issues).values({
      id: produceIssueId,
      companyId,
      missionId,
      title: "Conditional IF Activation: Produce",
      status: "blocked",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T07:01:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "produce",
        issueId: produceIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T07:01:00.000Z"),
        completedAt: new Date("2026-06-18T07:05:00.000Z"),
      },
      { workflowRunId: runId, stepId: "on-failure", issueId: null, status: "pending" },
      { workflowRunId: runId, stepId: "on-success", issueId: null, status: "pending" },
    ]);

    // 1차 sync: produce failed → on-failure 발화(FAILURE gate), on-success 는 false-branch → skipped.
    const first = await syncWorkflowRunForIssue(db, produceIssueId);
    expect(first?.status).toBe("running"); // on-failure 가 막 발화했으므로 running

    const rows1 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const byId1 = new Map(rows1.map((row) => [row.stepId, row]));
    expect(byId1.get("produce")?.status).toBe("failed");
    expect(byId1.get("on-failure")?.status).toBe("pending");
    expect(byId1.get("on-failure")?.issueId).toBeTruthy(); // failure-gated 발화 확인
    expect(byId1.get("on-success")?.status).toBe("skipped"); // false-branch skip
    expect((byId1.get("on-success")?.metadata as Record<string, unknown> | null)?.controlFlowSkipped).toBe(true);

    // 2차 sync: sentinel 덕분에 resetUnlaunchedTerminalStepRuns 가 on-success 를 skipped→pending 으로 부활시키지 않는다(가즈아 flap/hang 회귀 가드).
    await syncWorkflowRunForIssue(db, produceIssueId);
    const rows2 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const onSuccess2 = rows2.find((row) => row.stepId === "on-success");
    expect(onSuccess2?.status).toBe("skipped"); // 여전히 skipped — 부활 없음
    const onFailure2 = rows2.find((row) => row.stepId === "on-failure");
    expect(onFailure2?.status).toBe("pending"); // 발화 유지
    expect(onFailure2?.issueId).toBeTruthy();
  });

  it("[P2 control-flow] mixed workflow: legacy step downstream of a failed pred is skipped (not stuck pending) so the run is not hung", async () => {
    // 회귀 가드: conditional 이 하나라도 있는 워크플로에선 도달 불가 legacy step 도 skip 되어야 한다.
    // 이전엔 legacy-down 이 pending 에 갇혀 finalize 가 allStepsTerminal 에 도달 못 해 60min reconciler kill(가즈아 hang)을 유발했다.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const produceIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-control-flow-mixed" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Mixed",
      issuePrefix: `CM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mixed Flow Agent",
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
      title: "Conditional Mixed Mission",
      status: "active",
    });
    // produce[root] → on-failure(conditional when:failure), legacy-down(LEGACY dependencies:[produce]).
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Conditional IF Mixed",
      stepsJson: [
        { id: "produce", name: "Produce", agentId, dependencies: [], description: "Produce artifact" },
        {
          id: "on-failure",
          name: "Recover on failure",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "produce", when: "failure" }],
          description: "Run only when produce fails",
        },
        { id: "legacy-down", name: "Legacy downstream", agentId, dependencies: ["produce"], description: "Legacy dep on produce" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-06-18T08:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: produceIssueId,
      companyId,
      missionId,
      title: "Conditional IF Mixed: Produce",
      status: "blocked",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T08:01:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "produce",
        issueId: produceIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T08:01:00.000Z"),
        completedAt: new Date("2026-06-18T08:05:00.000Z"),
      },
      { workflowRunId: runId, stepId: "on-failure", issueId: null, status: "pending" },
      { workflowRunId: runId, stepId: "legacy-down", issueId: null, status: "pending" },
    ]);

    await syncWorkflowRunForIssue(db, produceIssueId);
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const byId = new Map(rows.map((row) => [row.stepId, row]));
    expect(byId.get("produce")?.status).toBe("failed");
    expect(byId.get("on-failure")?.status).toBe("pending");
    expect(byId.get("on-failure")?.issueId).toBeTruthy(); // failure-gated 발화
    // 핵심 회귀 단정: legacy-down 은 pending 에 갇히지 않고 skipped 로 마감(도달 불가).
    expect(byId.get("legacy-down")?.status).toBe("skipped");
    expect((byId.get("legacy-down")?.metadata as Record<string, unknown> | null)?.controlFlowSkipped).toBe(true);
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

  // ===== P4 control-flow: bounded back-edge loop (QA 반려 → producer rework → 재QA) =====
  // produce[root] → qa-validate(forward). produce 가 qa-validate 로 back-edge(when:qa_request_changes,
  //   isBackEdge, maxIterations). QA 반려 시 loop-driver 가 produce 를 리셋(rework). QA 재실행은 기존
  //   validation-recheck(producer 재완료 후 qa issue → todo) 가 담당. maxIterations cap 이 가즈아 무한 loop 방지.
  async function seedBackEdgeLoopRun(opts: { maxIterations: number; initialProducerIteration?: number }) {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop P4",
      issuePrefix: `CL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Loop Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-loop",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: opts.maxIterations }],
          description: "Produce the artifact. Do not validate your own output.",
        },
        { id: "qa-validate", name: "Validate the produced artifact", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T07:00:00.000Z"),
    });
    // produce 는 done(07:05) — QA verdict(07:10) 보다 먼저 완료(이래야 validation-recheck 가 아니라 loop-driver 가 발화).
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-loop: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "back-edge-loop: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: opts.initialProducerIteration ?? 0, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", startedAt: new Date("2026-06-18T07:03:00.000Z"), completedAt: new Date("2026-06-18T07:10:00.000Z") },
    ]);
    return { companyId, producerAgentId, qaAgentId, runId, producerIssueId, qaIssueId };
  }

  async function addQaVerdictComment(qaIssueId: string, companyId: string, qaAgentId: string, verdict: "REQUEST_CHANGES" | "PASS", at: string) {
    await db.insert(issueComments).values({
      companyId, issueId: qaIssueId, authorAgentId: qaAgentId, createdAt: new Date(at), body: `Decision: ${verdict}\nValidation review complete.`,
    });
  }

  it("[P4 control-flow loop] QA request_changes fires the back-edge: producer is reset (rework), iteration_index++ and attempt archived", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-fire" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    // QA 가 produce 완료(07:05) 후 반려(07:10).
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    heartbeatWakeup.mockClear();
    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    const qa = rows.find((row) => row.stepId === "qa-validate")!;
    // producer 리셋(rework): pending, iteration_index 0→1, attempt 아카이브.
    expect(produce.status).toBe("pending");
    expect(produce.iterationIndex).toBe(1);
    expect(produce.startedAt).toBeNull();
    expect(produce.completedAt).toBeNull();
    const attempts = (produce.metadata as Record<string, unknown> | null)?.controlFlowAttempts as Array<Record<string, unknown>> | undefined;
    expect(attempts).toHaveLength(1);
    expect(attempts![0]).toMatchObject({ iteration: 0, verdict: "request_changes" });
    // producer issue 도 "todo" 로 돌아야 step 이 pending 으로 재유도된다.
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    expect(producerIssue.status).toBe("todo");
    expect(producerIssue.completedAt).toBeNull();
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    const producerCommentBody = producerComments.map((comment) => comment.body).join("\n");
    expect(producerCommentBody).toContain("Workflow QA rework request");
    expect(producerCommentBody).toContain("qa-validate");
    expect(producerCommentBody).toContain("Decision: REQUEST_CHANGES");
    // producer 가 재실행(wake) 됐다.
    expect(heartbeatWakeup).toHaveBeenCalled();
    // QA 는 이 sync 에서 리셋하지 않는다(producer 가 아직 재완료 전이라 validation-recheck 도 미발화).
    expect(qa.status).toBe("failed");
    expect(qa.iterationIndex).toBe(0);
  });

  it("[P4 control-flow loop] carries QA heartbeat feedback into the producer rework issue before QA comment commit", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-feedback" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: qaAgentId,
      issueId: qaIssueId,
      status: "succeeded",
      startedAt: new Date("2026-06-18T07:09:00.000Z"),
      finishedAt: new Date("2026-06-18T07:10:00.000Z"),
      resultJson: {
        result: "REQUEST_CHANGES\n- Add a glossary before approval.",
      },
    });

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    const producerCommentBody = producerComments.map((comment) => comment.body).join("\n");
    expect(producerCommentBody).toContain("Workflow QA rework request");
    expect(producerCommentBody).toContain("QA heartbeat feedback");
    expect(producerCommentBody).toContain("Add a glossary before approval");
  });

  it("[P4 control-flow loop] maxIterations cap blocks further rework (no infinite loop): producer at cap is not reset", async () => {
    // 가즈아 무한 loop 회귀 가드: iteration_index 가 maxIterations 에 도달하면 더 이상 리셋하지 않는다.
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 1, initialProducerIteration: 1 });
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    // cap(=1) 도달 → 리셋 안 함: iteration_index 그대로 1, status completed 유지, issue 도 done 유지.
    expect(produce.iterationIndex).toBe(1);
    expect(produce.status).toBe("completed");
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    expect(producerIssue.status).toBe("done");
    // attempt 도 추가되지 않음(리셋 자체가 안 일어남).
    const attempts = (produce.metadata as Record<string, unknown> | null)?.controlFlowAttempts as unknown[] | undefined;
    expect(attempts ?? []).toHaveLength(0);
  });

  it("[P4 control-flow loop] bounded happy path: rework then QA pass → workflow completes (loop terminates)", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-happy" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    // Sync 1: QA 반려 → producer rework 리셋(iter 0→1) + 재실행.
    await syncWorkflowRunForIssue(db, producerIssueId);
    let rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!.iterationIndex).toBe(1);

    // producer rework 완료 시뮬레이션(QA verdict 07:10 보다 나중에 완료 → validation-recheck 가 QA 재큐).
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:30:00.000Z"), cancelledAt: null, startedAt: new Date("2026-06-18T07:11:00.000Z") }).where(eq(issues.id, producerIssueId));

    // Sync 2: validation-recheck 가 QA issue 를 "todo" 로 재큐(producer 07:30 > verdict 07:10) → QA 재실행.
    await syncWorkflowRunForIssue(db, producerIssueId);
    const [qaIssueAfterRework] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssueAfterRework.status).toBe("todo");

    // QA 재리뷰 PASS 시뮬레이션(producer 07:30 이후). QA issue done.
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "PASS", "2026-06-18T07:40:00.000Z");
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:40:00.000Z"), cancelledAt: null }).where(eq(issues.id, qaIssueId));

    // Sync 3: QA pass → completed, back-edge 미발화, finalize → 워크플로 완료.
    await syncWorkflowRunForIssue(db, qaIssueId);
    rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "qa-validate")!.status).toBe("completed");
    expect(rows.find((row) => row.stepId === "produce")!.iterationIndex).toBe(1); // rework 1회로 종료
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("completed");
  });

  it("[P4 control-flow loop] keeps downstream steps pending while QA request_changes is still recoverable", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-downstream" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const leadAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const claimsQaIssueId = randomUUID();
    const readabilityQaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop Downstream",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: leadAgentId, companyId, name: "Lead Agent", role: "lead", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Downstream Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-downstream",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [
            { stepId: "qa-claims", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
            { stepId: "qa-readability", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
          ],
          description: "Produce the artifact",
        },
        { id: "qa-claims", name: "Validate the produced artifact claims", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "qa-readability", name: "Validate the produced artifact readability", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "lead-approval", name: "Lead approval", agentId: leadAgentId, dependencies: ["qa-claims", "qa-readability"], description: "Approve validated artifact" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T08:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-downstream: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:01:00.000Z"), completedAt: new Date("2026-06-18T08:05:00.000Z") },
      { id: claimsQaIssueId, companyId, missionId, title: "back-edge-downstream: Validate the produced artifact claims", status: "done", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:09:00.000Z") },
      { id: readabilityQaIssueId, companyId, missionId, title: "back-edge-downstream: Validate the produced artifact readability", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-06-18T08:01:00.000Z"), completedAt: new Date("2026-06-18T08:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-claims", issueId: claimsQaIssueId, status: "completed", startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:09:00.000Z") },
      { workflowRunId: runId, stepId: "qa-readability", issueId: readabilityQaIssueId, status: "failed", startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:10:00.000Z") },
      { workflowRunId: runId, stepId: "lead-approval", status: "pending" },
    ]);
    await addQaVerdictComment(claimsQaIssueId, companyId, qaAgentId, "PASS", "2026-06-18T08:09:00.000Z");
    await addQaVerdictComment(readabilityQaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T08:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    let rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "lead-approval")!).toMatchObject({
      status: "pending",
      issueId: null,
    });

    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-06-18T08:30:00.000Z"),
      cancelledAt: null,
      startedAt: new Date("2026-06-18T08:11:00.000Z"),
    }).where(eq(issues.id, producerIssueId));
    await syncWorkflowRunForIssue(db, producerIssueId);

    await addQaVerdictComment(readabilityQaIssueId, companyId, qaAgentId, "PASS", "2026-06-18T08:40:00.000Z");
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T08:40:00.000Z"), cancelledAt: null }).where(eq(issues.id, readabilityQaIssueId));
    await syncWorkflowRunForIssue(db, readabilityQaIssueId);

    rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const lead = rows.find((row) => row.stepId === "lead-approval")!;
    expect(lead.status).toBe("pending");
    expect(lead.issueId).toBeTruthy();
  });

  it("[P4 control-flow loop] keeps downstream steps pending while audit request_changes is still recoverable", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-audit-downstream" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const auditAgentId = randomUUID();
    const writerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const auditIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Audit Loop Downstream",
      issuePrefix: `AD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Research Agent", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: auditAgentId, companyId, name: "Audit Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: writerAgentId, companyId, name: "Writer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Audit Back-edge Downstream Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "audit-back-edge-downstream",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect bounded evidence",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "audit-source-coverage", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
          description: "Collect source evidence",
        },
        {
          id: "audit-source-coverage",
          name: "Audit source coverage and confidence",
          agentId: auditAgentId,
          dependencies: ["collect-ai-news-evidence"],
          description: "Audit source coverage before synthesis",
        },
        {
          id: "synthesize-ai-news-report-draft",
          name: "Synthesize AI news report draft",
          agentId: writerAgentId,
          dependencies: ["audit-source-coverage"],
          description: "Write the report after audit passes",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-22T05:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "audit-back-edge-downstream: Collect bounded evidence", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-22T05:01:00.000Z"), completedAt: new Date("2026-06-22T05:05:00.000Z") },
      { id: auditIssueId, companyId, missionId, title: "audit-back-edge-downstream: Audit source coverage and confidence", status: "blocked", assigneeAgentId: auditAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-22T05:06:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect-ai-news-evidence", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-06-22T05:01:00.000Z"), completedAt: new Date("2026-06-22T05:05:00.000Z") },
      { workflowRunId: runId, stepId: "audit-source-coverage", issueId: auditIssueId, status: "failed", startedAt: new Date("2026-06-22T05:06:00.000Z"), completedAt: new Date("2026-06-22T05:10:00.000Z") },
      { workflowRunId: runId, stepId: "synthesize-ai-news-report-draft", status: "pending" },
    ]);
    await addQaVerdictComment(auditIssueId, companyId, auditAgentId, "REQUEST_CHANGES", "2026-06-22T05:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "collect-ai-news-evidence")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "synthesize-ai-news-report-draft")!).toMatchObject({
      status: "pending",
      issueId: null,
    });
  });

  it("[P4 control-flow loop] cascades skips after QA cap exhaustion so the workflow fails instead of hanging pending", async () => {
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const leadAgentId = randomUUID();
    const htmlAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop Exhausted Cascade",
      issuePrefix: `LX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: leadAgentId, companyId, name: "Lead Agent", role: "lead", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: htmlAgentId, companyId, name: "HTML Agent", role: "publisher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Exhausted Cascade Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-exhausted-cascade",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 1 }],
          description: "Produce the artifact",
        },
        { id: "qa-validate", name: "Validate the produced artifact", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "lead-approval", name: "Lead approval", agentId: leadAgentId, dependencies: ["qa-validate"], description: "Approve validated artifact" },
        { id: "build-html", name: "Build HTML", agentId: htmlAgentId, dependencies: ["lead-approval"], description: "Build HTML artifact" },
        { id: "publish-html", name: "Publish HTML", agentId: htmlAgentId, dependencies: ["build-html"], description: "Publish HTML artifact" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T09:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-exhausted-cascade: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "back-edge-exhausted-cascade: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: 1, startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", startedAt: new Date("2026-06-18T09:03:00.000Z"), completedAt: new Date("2026-06-18T09:10:00.000Z") },
      { workflowRunId: runId, stepId: "lead-approval", status: "pending" },
      { workflowRunId: runId, stepId: "build-html", status: "pending" },
      { workflowRunId: runId, stepId: "publish-html", status: "pending" },
    ]);
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T09:10:00.000Z");

    await syncWorkflowRunForIssue(db, qaIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "completed",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "qa-validate")!.status).toBe("failed");
    expect(rows.find((row) => row.stepId === "lead-approval")!.status).toBe("skipped");
    expect(rows.find((row) => row.stepId === "build-html")!.status).toBe("skipped");
    expect(rows.find((row) => row.stepId === "publish-html")!.status).toBe("skipped");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
  });

  it("[P4 control-flow loop] bounded failure: cap exhausted with persistent QA reject → workflow fails (no infinite loop)", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-fail" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 1 });
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    // Sync 1: QA 반려 → producer rework 리셋(iter 0→1). maxIterations=1 이므로 이 한 번이 유일한 rework.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find((row) => row.stepId === "produce")!.iterationIndex).toBe(1);

    // producer rework 완료 시뮬레이션(verdict 07:10 이후).
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:30:00.000Z"), cancelledAt: null, startedAt: new Date("2026-06-18T07:11:00.000Z") }).where(eq(issues.id, producerIssueId));

    // Sync 2: validation-recheck 가 QA 재큐(QA 재리뷰).
    await syncWorkflowRunForIssue(db, producerIssueId);
    const [qaIssueAfterRework] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssueAfterRework.status).toBe("todo");

    // QA 가 다시 반려(producer 07:30 이후). 이번엔 cap 초과라 producer 가 더 rework 못 한다.
    await addQaVerdictComment(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:40:00.000Z");
    await db.update(issues).set({ status: "blocked", completedAt: null, cancelledAt: null }).where(eq(issues.id, qaIssueId));

    // Sync 3: producer iter1 == cap → 리셋 안 함. QA failed → 워크플로 failed(무한 loop 아님).
    await syncWorkflowRunForIssue(db, producerIssueId);
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    expect(produce.iterationIndex).toBe(1); // cap 초과 없음
    expect(produce.status).toBe("completed");
    expect(rows.find((row) => row.stepId === "qa-validate")!.status).toBe("failed");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
  });
});
