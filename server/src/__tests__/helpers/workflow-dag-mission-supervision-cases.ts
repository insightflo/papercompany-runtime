import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { executeWorkflowRun } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagMissionSupervisionCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("runs active mission owner supervision and applies only safe workflow dispatch sync", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Active Supervision",
      issuePrefix: `AS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Active Supervisor Agent",
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
      title: "Active Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Active Supervision Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship" },
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
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Active Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Active Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["prepare", "ship"] },
    );

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-active-supervision" });
    await executeWorkflowRun(db, runId);
    const prepareStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "prepare") ?? null);
    expect(prepareStepRun?.issueId).toBeTruthy();

    await issueService(db).update(prepareStepRun!.issueId!, { status: "done" });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(result.missions[0]?.recommendations.map((recommendation) => recommendation.type)).not.toContain("dispatch_missing_step");
    expect(result.missions[0]?.appliedActions.map((action) => action.type)).not.toContain("dispatch_missing_step");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const shipStepRun = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(shipStepRun?.issueId).toBeTruthy();
    const [shipIssue] = await db.select().from(issues).where(eq(issues.id, shipStepRun!.issueId!)).limit(1);
    expect(shipIssue.status).toBe("todo");
  });

  it("includes aborted workflow missions in active owner supervision", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Aborted Supervision",
      issuePrefix: `AS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Aborted Supervisor Agent",
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
      title: "Aborted Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Aborted Supervision Workflow",
      stepsJson: [
        { id: "publish", name: "Publish", agentId, dependencies: [], description: "Publish" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "failed",
      completedAt: new Date(),
    });
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Aborted Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Aborted Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["publish"] },
    );
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "blocked",
      title: "Aborted Supervision Workflow: Publish",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "publish",
      issueId: blockedIssue.id,
      status: "failed",
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(result.missions[0]?.findings.join("\n")).toContain("blocked_without_replan");
    expect(result.missions[0]?.findings.join("\n")).toContain("failed_step_without_diagnosis");
  });
}
