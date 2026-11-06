import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missionPlanArtifacts, missions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagTriggerMissionCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("creates a mission for a workflow trigger without an existing mission and links run and step issues", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const stepId = "collect-news";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-mission" });

    await db.insert(companies).values({
      id: companyId,
      name: "Papercompany Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tech Scout Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "tech-scout report 생성",
      steps: [
        {
          id: stepId,
          name: "Collect AI infra news",
          agentId,
          dependencies: [],
          description: "Collect source material for the daily tech scout report",
        },
      ],
    });

    const result = await workflowService.trigger(db, {
      companyId,
      workflowId: definition.id,
      triggeredBy: "manual",
      runDate: "2026-06-12",
    });

    expect(result.status).toBe("running");

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId))
      .limit(1);
    expect(run?.missionId).toBeTruthy();

    const [mission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, run!.missionId!))
      .limit(1);
    expect(mission).toMatchObject({
      companyId,
      ownerAgentId: agentId,
      title: "2026-06-12 tech-scout report 생성",
      status: "active",
    });

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId))
      .limit(1);
    const [stepIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId!))
      .limit(1);
    expect(stepIssue).toMatchObject({
      missionId: run!.missionId,
      originKind: "workflow_execution",
      originId: result.runId,
      assigneeAgentId: agentId,
    });

    const missionIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, run!.missionId!));
    expect(missionIssues.find((issue) => issue.originKind === "mission_main_executor_plan")).toBeUndefined();
    const oversight = missionIssues.find((issue) => issue.originKind === "mission_main_executor_oversight");
    expect(oversight).toMatchObject({
      assigneeAgentId: agentId,
      missionId: run!.missionId,
      status: "todo",
      title: "[OVERSIGHT] tech-scout report 생성",
    });

    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, run!.missionId!));
    expect(planArtifacts).toEqual([
      expect.objectContaining({
        ownerAgentId: agentId,
        revision: 1,
        status: "active",
        refs: expect.objectContaining({
          oversightIssueId: oversight!.id,
          sourceRunId: result.runId,
          workflowName: "tech-scout report 생성",
          workflowStepIds: [stepId],
        }),
      }),
    ]);
  });
}
