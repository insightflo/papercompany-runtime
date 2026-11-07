import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { syncWorkflowRunState } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagResumeAssigneeCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("restores a released workflow step issue assignee before waking it on resume", async () => {
    const db = getDb();
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

    const result = await syncWorkflowRunState(db, runId, "workflow_execution", { requireRunning: true });

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
}
