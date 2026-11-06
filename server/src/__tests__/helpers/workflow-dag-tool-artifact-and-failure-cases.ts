import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi, type Mock } from "vitest";
import { agents, companies, issueExecutionCards, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { buildRuntimeSearchPathPermissions } from "../../services/runtime-search-path-permissions.js";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagToolArtifactAndFailureCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("hands an issue-less HTTP tool artifact to its dependent agent step", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";
    const artifactPath = `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/normalize/normalized_news_ledger.json`;
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-tool-artifact" });
    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "HTTP Tool Artifact Handoff Company",
      issuePrefix: `HA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      workProductRoot,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Evidence Analyst",
      role: "researcher",
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
      title: "HTTP tool artifact handoff",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "http-tool-artifact-handoff",
      stepsJson: [
        {
          id: "normalize",
          name: "Normalize source data",
          type: "tool",
          agentId: "",
          dependencies: [],
          toolNames: ["normalize-data"],
        },
        {
          id: "analyze",
          name: "Analyze normalized data",
          type: "agent",
          agentId,
          dependencies: ["normalize"],
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
    });

    await executeWorkflowRun(db, runId);
    await processQueuedWorkflowToolStepRuns(db);
    const [toolStep] = await db
      .select()
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.stepId, "normalize"),
      ));
    expect(toolStep?.lastDispatchRequestId).toBeTruthy();

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: toolStep!.id,
      requestId: toolStep!.lastDispatchRequestId!,
      workflowRunId: runId,
      stepId: "normalize",
      toolName: "normalize-data",
      success: true,
      data: { rawPath: artifactPath },
    });

    const [analyzeStep] = await db
      .select()
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.stepId, "analyze"),
      ));
    expect(analyzeStep?.issueId).toBeTruthy();
    const [analyzeIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, analyzeStep!.issueId!));
    expect(analyzeIssue?.description).toContain("Dependency tool artifacts:");
    expect(analyzeIssue?.description).toContain(artifactPath);

    const [card] = await db
      .select({ cardJson: issueExecutionCards.cardJson })
      .from(issueExecutionCards)
      .where(eq(issueExecutionCards.issueId, analyzeStep!.issueId!));
    expect(card?.cardJson.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dependency_tool_artifact",
        path: artifactPath,
      }),
    ]));

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: analyzeStep!.issueId!,
      workingDirectory: "/srv/papercompany/projects/research-company",
    });
    expect(permissions?.dependencyFiles).toEqual([artifactPath]);
  });

  it("records issue-less tool dispatch failures on the step run", async () => {
    const db = getDb();
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

    expect(result.status).toBe("running");
    const queuedBeforeDispatch = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(queuedBeforeDispatch[0]).toMatchObject({
      stepId: "collect",
      status: "running",
      lastDispatchErrorSummary: null,
    });

    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 1 });

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
}
