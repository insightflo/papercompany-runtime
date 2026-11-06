import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { companies, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagToolConcurrencyAndRetentionCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("dispatches higher-priority tool steps first and blocks lower-priority steps at the concurrency limit", async () => {
    const db = getDb();
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
    expect(executeToolStep).not.toHaveBeenCalled();
    const firstDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(firstDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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

    const secondDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(secondDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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
    const db = getDb();
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
    await processQueuedWorkflowToolStepRuns(db);
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
}
