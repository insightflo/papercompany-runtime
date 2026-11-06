import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { activityLog, agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { executeWorkflowRun } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagEntryStepCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("creates workflow entry step issues through the common lifecycle path and keeps the run active", async () => {
    const db = getDb();
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
      payload: expect.objectContaining({
        issueId: createdIssue!.id,
        mutation: "create",
        issueExecutionCardId: expect.any(String),
        issueExecutionCardHash: expect.any(String),
      }),
      requestedByActorType: "system",
      requestedByActorId: `workflow:${workflowId}`,
      contextSnapshot: expect.objectContaining({
        issueId: createdIssue!.id,
        source: "workflow.dispatch",
        paperclipIssueExecutionCardId: expect.any(String),
        paperclipIssueExecutionCardHash: expect.any(String),
      }),
    }));

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("running");
  });
}
