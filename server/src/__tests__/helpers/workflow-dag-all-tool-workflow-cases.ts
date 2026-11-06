import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { companies, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagAllToolWorkflowCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("completes all-tool workflows from tool execution results without creating issues", async () => {
    const db = getDb();
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
    expect(executeToolStep).not.toHaveBeenCalled();
    const fetchDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(fetchDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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
    const extractDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(extractDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
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
    await processQueuedWorkflowToolStepRuns(db);
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
}
