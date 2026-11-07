import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issueComments, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatToolLimitAndLeadGateCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("does not apply the REQUEST_CHANGES validation gate to workflow lead approval issues", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const leadIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Lead Approval",
      issuePrefix: "PLA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Research Director",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Approve corrected workflow output." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: leadIssueId,
      companyId,
      missionId,
      identifier: "PLA-LEAD",
      title: "Lead approval for corrected note",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementationOnce(async ({ runId, onLog }) => {
      await onLog("stdout", "APPROVED after checking prior REQUEST_CHANGES findings. Downstream may proceed.\n");
      await db
        .update(issues)
        .set({
          status: "done",
          checkoutRunId: runId,
          executionRunId: runId,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, leadIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: {
          result: "APPROVED. Prior REQUEST_CHANGES findings are fixed; do not re-block this lead approval.",
        },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "assignment",
      { taskKey: `issue:${leadIssueId}`, issueId: leadIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      leadIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, leadIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);

    const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, leadIssueId));
    expect(issueActivity.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);

    const nestedOwnerActions = await db.select().from(issues).where(eq(issues.originId, leadIssueId));
    expect(nestedOwnerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")).toBe(false);
  });

  it("captures tool-limit blocked mission child output as done", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the delegated source issue." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SOURCE",
        title: "[Source] Evidence packet",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db
        .update(issues)
        .set({ status: "blocked", executionRunId: runId })
        .where(eq(issues.id, childIssueId));
      await onLog(
        "stdout",
        "Evidence matrix is ready.\nReached maximum iterations (60). I could not post the issue comment before the tool-call limit hit.\n",
      );
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue?.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("Evidence matrix is ready"))).toBe(true);
  });
}
