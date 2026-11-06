import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, workflowDelegations, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, processQueuedWorkflowToolStepRuns } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagCrossCompanyDelegationCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("delegates native workflow steps to another company and resumes with copied workProducts", async () => {
    const db = getDb();
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-delegation-target" });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Company",
        issuePrefix: `SC${sourceCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Target Company",
        issuePrefix: `TC${targetCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId: sourceCompanyId,
        name: "Source Synthesizer",
        role: "Synthesis",
        adapter: "mock",
        adapterConfig: {},
        status: "active",
      },
      {
        id: targetAgentId,
        companyId: targetCompanyId,
        name: "Target Researcher",
        role: "Research",
        adapter: "mock",
        adapterConfig: {},
        status: "active",
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId: sourceCompanyId,
      name: "Cross Company Workflow",
      stepsJson: [
        {
          id: "request-research",
          name: "Request Research",
          agentId: "",
          dependencies: [],
          toolNames: ["delegate_to_company"],
          toolArgs: {
            targetCompanyId,
            targetAssigneeAgentId: targetAgentId,
            title: "Research delegated input",
            description: "Produce the research artifact for the source workflow.",
          },
        },
        {
          id: "synthesize",
          name: "Synthesize",
          agentId: sourceAgentId,
          dependencies: ["request-research"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId: sourceCompanyId,
      triggeredBy: "system",
      status: "pending",
    });

    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");

    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const queuedDelegateStep = stepRuns.find((stepRun) => stepRun.stepId === "request-research")!;
    const queuedSynthesizeStep = stepRuns.find((stepRun) => stepRun.stepId === "synthesize")!;
    expect(queuedDelegateStep).toMatchObject({ status: "running", issueId: null });
    expect(queuedSynthesizeStep).toMatchObject({ status: "pending", issueId: null });

    const delegateDispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(delegateDispatch).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const delegateStep = stepRuns.find((stepRun) => stepRun.stepId === "request-research")!;
    const synthesizeStep = stepRuns.find((stepRun) => stepRun.stepId === "synthesize")!;
    expect(delegateStep).toMatchObject({ status: "running" });
    expect(delegateStep.issueId).toBeTruthy();
    expect(synthesizeStep).toMatchObject({ status: "pending", issueId: null });

    const [delegation] = await db
      .select()
      .from(workflowDelegations)
      .where(eq(workflowDelegations.sourceWorkflowStepRunId, delegateStep.id));
    expect(delegation).toMatchObject({
      sourceCompanyId,
      targetCompanyId,
      status: "active",
    });
    expect(delegation.sourceIssueId).toBe(delegateStep.issueId);
    expect(delegation.targetIssueId).toBeTruthy();

    const [targetIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, delegation.targetIssueId));
    expect(targetIssue).toMatchObject({
      companyId: targetCompanyId,
      assigneeAgentId: targetAgentId,
      status: "todo",
      originKind: "workflow_delegation_target",
      originId: delegateStep.id,
    });

    await db.insert(issueWorkProducts).values({
      companyId: targetCompanyId,
      issueId: targetIssue.id,
      type: "report",
      provider: "local",
      externalId: "target-report.html",
      title: "Target research report",
      status: "ready",
      reviewState: "approved",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Delegated research is complete.",
      metadata: { path: "/tmp/target-report.html" },
    });

    const updatedTarget = await issueService(db).update(targetIssue.id, { status: "done" });
    expect(updatedTarget?.status).toBe("done");

    const [completedDelegation] = await db
      .select()
      .from(workflowDelegations)
      .where(eq(workflowDelegations.id, delegation.id));
    expect(completedDelegation.status).toBe("completed");
    expect(completedDelegation.completedAt).toBeTruthy();

    const sourceProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, delegation.sourceIssueId!));
    expect(sourceProducts).toEqual([
      expect.objectContaining({
        companyId: sourceCompanyId,
        issueId: delegation.sourceIssueId,
        provider: "delegated",
        externalId: `delegated:${sourceProducts[0]!.metadata && (sourceProducts[0]!.metadata as any).delegatedFrom.workProductId}`,
        title: "Target research report",
        isPrimary: true,
      }),
    ]);
    expect(sourceProducts[0]!.metadata).toMatchObject({
      delegatedFrom: {
        companyId: targetCompanyId,
        issueId: targetIssue.id,
      },
      originalProvider: "local",
      originalExternalId: "target-report.html",
    });

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const completedDelegateStep = stepRuns.find((stepRun) => stepRun.stepId === "request-research")!;
    const launchedSynthesizeStep = stepRuns.find((stepRun) => stepRun.stepId === "synthesize")!;
    expect(completedDelegateStep).toMatchObject({ status: "completed", issueId: delegation.sourceIssueId });
    expect(launchedSynthesizeStep.issueId).toBeTruthy();
    expect(launchedSynthesizeStep.status).toBe("pending");

    const [synthesisIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, launchedSynthesizeStep.issueId!));
    expect(synthesisIssue.description).toContain("Dependency issue inputs:");
    expect(synthesisIssue.description).toContain("Target research report [report/ready]");
    expect(synthesisIssue.description).toContain("delegated:");
  });
}
