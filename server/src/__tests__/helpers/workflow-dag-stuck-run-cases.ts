import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { reconcileStuckWorkflowRuns } from "../../services/workflow/reconciler.js";

export function registerWorkflowDagStuckRunCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("does not mark unlaunched downstream tool steps as failed when a stuck run is terminalized", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Stuck Tool Cascade Company",
      issuePrefix: `ST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "stuck-tool-cascade",
      stepsJson: [
        { id: "inspection", name: "Inspection", type: "agent", agentId: "", dependencies: [] },
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          type: "tool",
          toolNames: ["gazua.oracle-data-sync"],
          dependencies: ["inspection"],
        },
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
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "inspection",
        status: "failed",
        completedAt: new Date("2020-01-01T01:00:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "sync-dashboard",
        status: "pending",
        metadata: { graphWorkProductRequired: false },
      },
    ]);

    const result = await reconcileStuckWorkflowRuns(db, 60);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");
    const storedSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(storedSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "inspection", status: "failed" }),
      expect.objectContaining({
        stepId: "sync-dashboard",
        status: "skipped",
        startedAt: null,
        lastDispatchAttemptAt: null,
        lastDispatchRequestId: null,
        metadata: expect.objectContaining({ failureCascadeSkipped: true }),
      }),
    ]));
  });

  it("does not fail pending downstream steps while a linked workflow issue is still active", async () => {
    const db = getDb();
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
}
