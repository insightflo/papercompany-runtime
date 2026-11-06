import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi, type Mock } from "vitest";
import { agents, companies, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagLegacyPluginAssigneeCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("resolves legacy plugin workflow step agentName to the company agent assignee", async () => {
    const db = getDb();
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

  it("queues issue-less tool steps and advances dependent agent steps after queued tool result", async () => {
    const db = getDb();
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
    expect(toolStep?.lastDispatchRequestId).toBeTruthy();
    expect(toolStep?.lastDispatchAcceptedAt).toBeNull();
    expect(executeToolStep).not.toHaveBeenCalled();

    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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
      requestId: toolStep!.lastDispatchRequestId!,
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
}
