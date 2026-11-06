import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";

export function registerWorkflowDagStaleDispatchCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("observes stale workflow todo dispatch omissions without hard-blocking", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Supervision",
      issuePrefix: `WS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Supervisor Agent",
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
      title: "Supervision Workflow Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Supervision Workflow",
      stepsJson: [
        { id: "publish", name: "Publish", agentId, dependencies: [], description: "Publish the output" },
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

    const issueSvc = issueService(db);
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Supervision Workflow Mission", description: null, status: "active", source: "manual", createdAt: new Date(), updatedAt: new Date() },
      "Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["publish"] },
    );
    const stepIssue = await issueSvc.create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "todo",
      title: "Supervision Workflow: Publish",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "publish",
      issueId: stepIssue.id,
      status: "pending",
    });

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(supervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(supervision.findings.join("\n")).toContain("stale_todo");
    expect(supervision.findings.join("\n")).toContain("dispatch_omission");

    const [planArtifact] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .limit(1);
    expect(planArtifact.refs).toEqual(expect.objectContaining({
      oversightIssueId: oversightIssue.id,
      sourceRunId: runId,
      workflowName: "Supervision Workflow",
      workflowStepIds: ["publish"],
    }));
    const [stepIssueAfter] = await db.select().from(issues).where(eq(issues.id, stepIssue.id)).limit(1);
    expect(stepIssueAfter.status).toBe("todo");

    const repeatedSameFinding = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(repeatedSameFinding.commented).toBe(false);

    await issueSvc.update(stepIssue.id, { status: "blocked" });
    const newFindingSameHour = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(newFindingSameHour.commented).toBe(true);
    expect(newFindingSameHour.findings.join("\n")).toContain("blocked_without_replan");

    const commentsAfterSignatureDedupe = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    expect(commentsAfterSignatureDedupe.length).toBeGreaterThanOrEqual(2);
  });

  it("observes stale todo issues whose only execution run failed", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const oldCreatedAt = new Date(Date.now() - 10 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Failed Todo Supervision",
      issuePrefix: `FT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Failed Todo Supervisor Agent",
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
      title: "Failed Todo Supervision Mission",
      status: "active",
      source: "workflow",
    });
    const oversightIssue = await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Failed Todo Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Failed Todo Supervision Workflow",
      {},
    );
    const staleIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "manual",
      status: "todo",
      title: "Run failed but issue still appears queued",
    });
    await db.update(issues).set({ createdAt: oldCreatedAt }).where(eq(issues.id, staleIssue.id));
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      issueId: staleIssue.id,
      status: "failed",
      errorCode: "adapter_failed",
      error: "access token could not be refreshed",
      exitCode: 1,
      createdAt: oldCreatedAt,
      startedAt: oldCreatedAt,
      finishedAt: new Date(oldCreatedAt.getTime() + 10_000),
    });

    const directSupervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(),
    });
    expect(directSupervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(directSupervision.findings.join("\n")).toContain("stale_todo_after_failed_run");
    expect(directSupervision.recommendations.map((recommendation) => recommendation.type)).toEqual(expect.arrayContaining(["retry_unit_if_safe", "request_replan"]));

    const activeSupervision = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(activeSupervision.missionIds).toContain(missionId);
    expect(activeSupervision.missions[0]?.findings.join("\n")).toContain("stale_todo_after_failed_run");
  });
}
