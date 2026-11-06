import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missionPlanArtifacts, missions, pluginEntities, plugins, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagPlanAndCancelCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  it("observes active plan required inputs, approval gates, rule mismatch, and plan drift without blocking", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plan drift supervision",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plan Drift Supervisor",
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
      title: "Plan drift mission",
      status: "active",
      source: "workflow",
    });
    await missionService(db).ensureMainExecutorOversightIssue(
      { id: missionId, companyId, ownerAgentId: agentId, title: "Plan drift mission", description: null, status: "active", source: "workflow", createdAt: new Date(), updatedAt: new Date() },
      "Plan Drift Workflow",
    );
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine.plan-drift",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: { id: "insightflo.workflow-engine.plan-drift", name: "Workflow Engine", version: "1.0.0" },
      status: "ready",
    });
    await db.insert(pluginEntities).values({
      id: pluginRunId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-run:${pluginRunId}`,
      title: "Plan drift run",
      status: "running",
      data: {
        workflowId: randomUUID(),
        workflowName: "Plan Drift Workflow",
        companyId,
        missionId,
        status: "running",
      },
    });
    await db.update(missionPlanArtifacts)
      .set({
        refs: {
          schemaVersion: 2,
          executionUnits: [
            {
              sourceRef: { type: "plugin_workflow_run", id: pluginRunId },
              status: "pending",
              actionCategory: "external_cost",
            },
          ],
          ruleRefs: [{ key: "cost-approval", mode: "approval_gate" }],
        },
        requiredInputs: [{ key: "budget_limit", status: "requested" }],
        successCriteria: [],
        risks: [],
        steps: [],
      })
      .where(eq(missionPlanArtifacts.missionId, missionId));

    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
      applySafeActions: true,
    });

    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    const findings = missionResult?.findings.join("\n") ?? "";
    expect(findings).toContain("missing_required_input");
    expect(findings).toContain("approval_required");
    expect(findings).toContain("rule_mismatch");
    expect(findings).not.toContain("plan_outdated");
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_approval", safeToAutoApply: false }),
    ]));
    expect(missionResult?.appliedActions).toEqual([]);

    const pluginStepId = randomUUID();
    await db.insert(pluginEntities).values({
      id: pluginStepId,
      pluginId,
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: `workflow-step-run:${pluginStepId}`,
      title: "Unplanned step",
      status: "running",
      data: {
        workflowRunId: pluginRunId,
        stepId: "unplanned-step",
        status: "running",
        companyId,
      },
    });

    const changedResult = await missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    const changedMissionResult = changedResult.missions.find((entry) => entry.missionId === missionId);
    expect(changedMissionResult?.commented).toBe(true);
    expect(changedMissionResult?.findings.join("\n")).toContain("plan_outdated");
  });

  it("cancels outstanding workflow execution issues when a workflow run is cancelled", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-cancel" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Cancel",
      issuePrefix: `WC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Cancel Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Cancelable Workflow",
      steps: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship the work" },
      ],
    });

    const result = await workflowService.trigger(db, {
      companyId,
      workflowId: definition.id,
      triggeredBy: "manual",
    });

    expect(result.status).toBe("running");

    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId));
    const prepareStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "prepare");
    const shipStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(prepareStepRun?.issueId).toBeTruthy();
    expect(shipStepRun?.issueId).toBeNull();

    const cancelled = await workflowService.cancelRun(db, { runId: result.runId, companyId });
    expect(cancelled).toBe(true);

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("cancelled");

    const cancelledIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, prepareStepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(cancelledIssue).toMatchObject({
      status: "cancelled",
      originKind: "workflow_execution",
      originRunId: result.runId,
    });
    expect(cancelledIssue?.cancelledAt).toBeTruthy();

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(finalStepRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: "prepare", status: "failed" }),
      expect.objectContaining({ stepId: "ship", status: "skipped" }),
    ]));
  });
}
