import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { companies, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagToolArgsAndCacheCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("renders workflow runDate placeholders in issue-less tool step args without implicit date injection", async () => {
    const db = getDb();
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
    expect(executeToolStep).not.toHaveBeenCalled();
    const queuedResult = await processQueuedWorkflowToolStepRuns(db);
    expect(queuedResult).toMatchObject({ claimedCount: 3, executedCount: 3, failedCount: 0 });
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
    const db = getDb();
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
    expect(executeToolStep).not.toHaveBeenCalled();
    const firstDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(firstDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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
}
