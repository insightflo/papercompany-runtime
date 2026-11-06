import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatStepSyncCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus, mockRequestChangesOnce }: HeartbeatBudgetCaseContext) {
  it("does not block a 'review' titled issue from REQUEST_CHANGES text in the checked-out run alone", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Review",
      issuePrefix: "PRV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Review Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the deliverable." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "lead",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Review report workflow",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PRV-REVIEW",
      title: "Review editorial consistency of the report",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    mockRequestChangesOnce(db, issueId, [
      "REQUEST_CHANGES",
      "",
      "- Tone is inconsistent across sections two and four.",
    ]);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);
  });

  it("syncs workflow step runs after auto-completing a successful workflow execution issue", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedStepRunId = randomUUID();
    const followupStepRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Workflow Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the checked out issue." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Workflow QA Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the completed workflow step." },
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Two step workflow",
      stepsJson: [
        { id: "draft", name: "Draft", agentId, dependencies: [] },
        { id: "review", name: "Review", agentId: qaAgentId, dependencies: ["draft"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-WF-1",
      title: "Draft workflow output",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values([
      {
        id: completedStepRunId,
        workflowRunId,
        stepId: "draft",
        issueId,
        status: "running",
        startedAt: new Date(),
      },
      {
        id: followupStepRunId,
        workflowRunId,
        stepId: "review",
        issueId: null,
        status: "pending",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const deadline = Date.now() + 5_000;
    let stepRuns: (typeof workflowStepRuns.$inferSelect)[] = [];
    while (Date.now() < deadline) {
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
      const draft = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
      const review = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);
      if (draft?.status === "completed" && review?.issueId) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const draftStep = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
    const reviewStep = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);

    expect(draftStep).toEqual(
      expect.objectContaining({
        status: "completed",
        issueId,
      }),
    );
    expect(draftStep?.completedAt).toBeInstanceOf(Date);
    expect(reviewStep).toEqual(
      expect.objectContaining({
        status: "pending",
        issueId: expect.any(String),
      }),
    );
    const reviewIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewStep!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(reviewIssue).toEqual(
      expect.objectContaining({
        assigneeAgentId: qaAgentId,
        originKind: "workflow_execution",
        originRunId: workflowRunId,
        status: "todo",
      }),
    );
  });
}
