import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunState } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagStepResumeCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("copies execution controls into workflow step run metadata when launching a step", async () => {
    const db = getDb();
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
    const db = getDb();
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

    const result = await syncWorkflowRunState(db, runId, "workflow_execution", { requireRunning: true });

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
}
