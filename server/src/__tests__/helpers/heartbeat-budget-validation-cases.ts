import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, companies, issueComments, issues, missions, qualityReviewItems } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatValidationCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus, mockRequestChangesOnce }: HeartbeatBudgetCaseContext) {
  it("does not block an audit issue from REQUEST_CHANGES text in Codex stdout alone", async () => {
    const db = getDb();
    // Official workflow_validation_verdict ledger is authority; stdout REQUEST_CHANGES is not.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

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
        name: "Source Audit Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Validate readability." },
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
      title: "Validate report workflow",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-VAL",
      title: "Audit source coverage and confidence",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    mockRequestChangesOnce(db, issueId, [
      "REQUEST_CHANGES",
      "",
      "- Add a glossary for beginner-facing jargon.",
      "- Normalize the source-window wording.",
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

    const qualityItems = await db.select().from(qualityReviewItems).where(eq(qualityReviewItems.missionId, missionId));
    expect(qualityItems.some((item) => item.triggerSource === "final_qa_failure")).toBe(false);
  });

  it("does not block final QA from a markdown-rule-prefixed REQUEST_CHANGES agent message in stdout", async () => {
    const db = getDb();
    // Structured workflow_validation_verdict is authority; agent message text is not.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Delivery",
      issuePrefix: "PDL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Final QA Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Verify mission result." },
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
      title: "Manual onboarding publish",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PDL-QA",
      title: "[QA] Verify mission result",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ runId, agent }) => {
      if (agent.id !== agentId) return successfulAdapterResult();
      await db
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      return {
        ...successfulAdapterResult(),
        resultJson: {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
            JSON.stringify({
              type: "item.completed",
              item: {
                id: "item-final",
                type: "agent_message",
                text: [
                  "---",
                  "",
                  "**REQUEST_CHANGES: workProduct preview URL points to the hub shell, not the detail content**",
                  "",
                  "Delivery readback saw HTTP 200, but the page body had the wrong title and zero topic markers.",
                ].join("\n"),
              },
            }),
          ].join("\n"),
        },
      };
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
}
