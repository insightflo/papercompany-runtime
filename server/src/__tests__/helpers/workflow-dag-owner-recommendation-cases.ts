import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, pluginEntities, plugins, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";

export function registerWorkflowDagOwnerRecommendationCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("keeps retry replan and escalation recommendations as owner actions, not automatic changes", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Unsafe Supervision",
      issuePrefix: `US${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Unsafe Supervisor Agent",
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
      title: "Unsafe Supervision Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unsafe Supervision Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare" },
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
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Unsafe Supervision Mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Unsafe Supervision Workflow",
      { sourceRunId: runId, workflowStepIds: ["prepare"] },
    );
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "workflow_execution",
      originRunId: runId,
      status: "blocked",
      title: "Unsafe Supervision Workflow: Prepare",
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId: runId,
      stepId: "prepare",
      issueId: blockedIssue.id,
      status: "failed",
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const recommendations = result.missions[0]?.recommendations.map((recommendation) => recommendation.type) ?? [];
    expect(recommendations).toContain("retry_failed_step_if_safe");
    expect(recommendations).toContain("request_replan");
    expect(recommendations).toContain("escalate_blocked");
    expect(result.missions[0]?.appliedActions).toEqual([]);

    const [blockedIssueAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssue.id)).limit(1);
    expect(blockedIssueAfter.status).toBe("blocked");
    const [stepRunAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.issueId, blockedIssue.id)).limit(1);
    expect(stepRunAfter.status).toBe("failed");
  });

  it("selects plugin-only active missions for owner supervision", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin-only Supervision Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Supervisor Agent",
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
      title: "Plugin-only Workflow Mission",
      status: "active",
      source: "workflow",
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.supervision",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.supervision", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plugin-only active run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plugin Supervision Workflow",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
      },
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions.map((mission) => mission.missionId)).toContain(missionId);
  });


  it("diagnoses plugin failed units without linked issues as owner-decision findings", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();
    const pluginStepId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin failed unit supervision",
      issuePrefix: `PF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Failed Unit Supervisor",
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
      title: "Plugin failed unit mission",
      status: "active",
      source: "workflow",
    });
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Plugin failed unit mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Plugin Failed Unit Workflow",
    );
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.failed-unit",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.failed-unit", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plugin failed run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plugin Failed Unit Workflow",
        companyId,
        missionId,
        status: "running",
        triggerSource: "schedule",
      },
    });
    await db.insert(pluginEntities).values({
      id: pluginStepId,
      pluginId,
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-step-run:${pluginStepId}`,
      title: "External publish",
      status: "failed",
      data: {
        workflowRunId: pluginRunId,
        stepId: "external-publish",
        status: "failed",
        companyId,
      },
    });

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings.join("\n")).toContain("failed_unit_without_diagnosis");
    expect(missionResult?.findings.join("\n")).toContain(pluginStepId);
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "retry_unit_if_safe", safeToAutoApply: false }),
      expect.objectContaining({ type: "request_replan", safeToAutoApply: false }),
    ]));
    expect(missionResult?.appliedActions).toEqual([]);
  });
}
