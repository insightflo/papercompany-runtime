import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { reconcileDeadlockedWorkflowRuns, reconcileStuckWorkflowRuns } from "../../services/workflow/reconciler.js";

export function registerWorkflowDagGateAndReworkCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("deadlock fast-path: does NOT converge an injected delivery verification gate with a reachable todo issue", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const gateIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Delivery Gate Deadlock Company",
      issuePrefix: `DG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "cloudflare-delivery",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "publish", name: "Publish Cloudflare Pages site", type: "agent", agentId: "", dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: gateIssueId,
      companyId,
      identifier: "DG-1",
      title: "Verify public delivery",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "publish", status: "completed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "delivery-verification-gate", status: "pending", issueId: gateIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const gate = steps.find((step) => step.stepId === "delivery-verification-gate");
    expect(gate?.status).toBe("pending");
    expect((gate?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBeUndefined();

    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, gateIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, gateIssueId));
    expect(comments).toHaveLength(0);
  });

  it("deadlock fast-path: converges a dynamic owner plan when pending declarations are not launcher-eligible", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Dynamic Owner Deadlock Company",
      issuePrefix: `DO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "dynamic-owner-plan",
      executionMode: "dynamic_owner_plan",
      stepsJson: [
        { id: "plan", name: "Plan", type: "agent", agentId: "", dependencies: [] },
        { id: "owner-escalation", name: "Owner escalation", type: "agent", agentId: "", triggerOn: "escalation", dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "plan", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "owner-escalation", status: "pending" },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const escalation = steps.find((step) => step.stepId === "owner-escalation");
    expect(escalation?.status).toBe("skipped");
    expect((escalation?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);
  });

  it("[P7] does not kill a rework iteration while a workflow wakeup is live", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const qaIssueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Iterating Loop Company",
      issuePrefix: `IL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "iterating-loop",
      stepsJson: [
        { id: "produce", name: "Produce", type: "agent", agentId: "", dependencies: [] },
        { id: "qa", name: "QA", type: "agent", agentId: "", dependencies: ["produce"] },
      ],
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Loop Worker", role: "worker" });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      completedAt: null,
    });
    await db.insert(issues).values({ id: qaIssueId, companyId, title: "QA", status: "todo" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", status: "completed", iterationIndex: 1, startedAt: new Date("2020-01-01T00:00:00.000Z"), completedAt: new Date("2020-01-01T00:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa", issueId: qaIssueId, status: "pending", iterationIndex: 1 },
    ]);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      issueId: qaIssueId,
      workflowRunId: runId,
      source: "test",
      reason: "workflow_resume",
      status: "queued",
    });

    const result = await reconcileStuckWorkflowRuns(db, 60);
    expect(result).toEqual([
      expect.objectContaining({ runId, action: "skipped", reason: expect.stringContaining("actively executing") }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
  });
}
