import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issueComments, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatOversightTimeoutCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, failedAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("blocks a timed-out checked-out issue with a reason comment", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timeout Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Do the work." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-TIMEOUT",
      title: "Timeout lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async () =>
      failedAdapterResult({ timedOut: true, errorCode: "timeout", errorMessage: "Timed out after test budget" }),
    );
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("timed_out");
    await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "blocked" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("RUN_TIMED_OUT"))).toBe(true);
  });

  it("releases timed-out mission oversight back to todo instead of blocking the supervisor", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Check the mission." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oversight timeout mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-OVERSIGHT",
      title: "[OVERSIGHT] Timeout lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
    });

    executeSpy.mockImplementation(async () =>
      failedAdapterResult({ timedOut: true, errorCode: "timeout", errorMessage: "Timed out after test budget" }),
    );
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("timed_out");
    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "todo" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Mission oversight run failed but the supervisor issue remains open"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("RUN_TIMED_OUT"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mission.oversight_run_failure_observed",
          entityType: "mission",
          entityId: missionId,
        }),
      ]),
    );
    expect(activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: issueId }),
      ]),
    );
  });

  it("keeps successful active mission oversight open instead of auto-completing it", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Check the mission." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oversight success mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-OVERSIGHT",
      title: "[OVERSIGHT] Success lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({
          status: "in_progress",
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "todo" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("supervisor issue remains open"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mission.oversight_run_succeeded_released",
          entityType: "mission",
          entityId: missionId,
        }),
      ]),
    );
    expect(activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_succeeded_auto_completed", entityId: issueId }),
      ]),
    );
  });
}
