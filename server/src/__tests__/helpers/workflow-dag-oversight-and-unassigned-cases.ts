import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagOversightAndUnassignedCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("rejects completing mission oversight while workflow steps remain active", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Oversight Guard Workflow",
      issuePrefix: `OG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
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
      title: "Oversight guard mission",
      status: "active",
    });
    const issueSvc = issueService(db);
    const oversight = await issueSvc.create(companyId, {
      missionId,
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Oversight guard mission",
      status: "todo",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Oversight Guard Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(workflowStepRuns).values([
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "collect",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: randomUUID(),
        workflowRunId: runId,
        stepId: "synthesize",
        status: "pending",
      },
    ]);

    await expect(issueSvc.update(oversight.id, { status: "done" }))
      .rejects.toThrow(/Cannot complete mission oversight/);

    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversight.id));
    expect(storedOversight?.status).toBe("todo");
  });

  it("creates unassigned issues for workflow steps without an agent", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Unassigned Workflow",
      issuePrefix: `WU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unassigned Workflow",
      stepsJson: [
        {
          id: "manual-review",
          name: "Manual review",
          agentId: "",
          dependencies: [],
          description: "Needs operator assignment later",
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

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]).toMatchObject({
      title: "Manual review",
      assigneeAgentId: null,
      originKind: "workflow_execution",
      originRunId: runId,
    });
    expect(heartbeatWakeup).not.toHaveBeenCalled();
  });
}
