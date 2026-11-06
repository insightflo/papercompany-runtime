import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { reconcileDeadlockedWorkflowRuns, reconcileRunnableWorkflowStepWakeups } from "../../services/workflow/reconciler.js";

export function registerWorkflowDagParallelAndWakeupCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("deadlock fast-path: does NOT converge a PARALLEL dag when an independent branch is still runnable (only the failed branch's downstream is unreachable)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const branchBIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Parallel DAG Company",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Two independent branches. branchA: a -> a2. branchB: b -> b2.
    // a2 depends on a (failed) -> unreachable. b is an entry step (runnable);
    // b2 depends on b (still pending) -> waiting, not unreachable.
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "parallel-dag",
      stepsJson: [
        { id: "a", name: "A", type: "agent", agentId: "", dependencies: [] },
        { id: "a2", name: "A2", type: "agent", agentId: "", dependencies: ["a"] },
        { id: "b", name: "B", type: "agent", agentId: "", dependencies: [] },
        { id: "b2", name: "B2", type: "agent", agentId: "", dependencies: ["b"] },
      ],
    });
    // startedAt is 6 min ago -> past the 5-min settling gate. Branch A failed,
    // branch B has NOT been picked up by the launcher yet (still pending).
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: branchBIssueId,
      companyId,
      identifier: "PD-1",
      title: "B",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "a", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "a2", status: "pending" },
      { workflowRunId: runId, stepId: "b", status: "pending", issueId: branchBIssueId },
      { workflowRunId: runId, stepId: "b2", status: "pending" },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    // Not deadlocked: branch B is still runnable. The run must keep going.
    expect(result).toEqual([]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const findStep = (stepId: string) => steps.find((step) => step.stepId === stepId);

    // The independent parallel branch is NOT skipped/blocked -- it stays runnable.
    const branchB = findStep("b");
    expect(branchB?.status).toBe("pending");
    expect((branchB?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();
    const branchB2 = findStep("b2");
    expect(branchB2?.status).toBe("pending");
    expect((branchB2?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();

    // The failed branch's downstream is also left untouched this tick (the reconciler
    // does not partially converge; the launcher/normal skip-pass handles a2). The
    // invariant under test is only that nothing is wrongly force-skipped/blocked.
    expect(findStep("a2")?.status).toBe("pending");

    // The linked issue on the runnable branch is NOT blocked.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, branchBIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, branchBIssueId));
    expect(comments).toHaveLength(0);
  });

  it("reconciler queues a missing workflow_resume wakeup for a runnable todo step", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-workflow-resume" });

    await db.insert(companies).values({
      id: companyId,
      name: "Runnable Wakeup Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runnable Agent",
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
      name: "runnable-wakeup-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId, dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RW-1",
      title: "Collect",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "collect",
      status: "pending",
      issueId,
    });

    const result = await reconcileRunnableWorkflowStepWakeups(db);

    expect(result).toEqual([expect.objectContaining({
      runId,
      action: "recovered",
      reason: expect.stringContaining("Queued missing workflow_resume wakeup"),
    })]);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment",
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId,
        mutation: "workflow_resume",
        workflowRunId: runId,
        workflowDefinitionId: workflowId,
        stepId: "collect",
      }),
    }));
  });
}
