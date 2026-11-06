import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issueComments, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatRootPlanIssueCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, failedAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("auto-completes a successful root/plan issue after its planning run succeeds", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Director",
      role: "owner",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: { command: "mimo25pro", promptTemplate: "Plan and delegate only." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Root closeout mission",
      status: "planning",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[Plan] Root planning issue",
      description: "Create child issues and stop.",
      status: "todo",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    executeSpy.mockImplementation(async () => successfulAdapterResult());
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "assignment",
      { taskKey: `issue:${rootIssueId}`, issueId: rootIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const updatedIssue = await waitForIssueStatus(
      db,
      rootIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({ status: "done", completedAt: expect.any(Date) }));
  });

  it("blocks a failed mission worker issue and leaves observable oversight/fallback evidence", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
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
        name: "Mission Director",
        role: "owner",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: { command: "mimo26pro" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Kimi Worker",
        role: "researcher",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: { command: "mimo25pro", promptTemplate: "Do bounded source work." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Failure oversight mission", status: "active" });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Failure oversight",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SOURCE",
        title: "[Source] Kimi quota case",
        status: "todo",
        assigneeAgentId: workerAgentId,
        originKind: "director_plan_source",
      },
    ]);

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stderr", "HTTP 403: Kimi provider quota exceeded. Try another model.\n");
      return failedAdapterResult({
        errorCode: "provider_403",
        errorMessage: "HTTP 403: Kimi provider quota exceeded",
        provider: "kimi",
        model: "kimi-k2",
      });
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      workerAgentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("blocked");

    const childComments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(childComments.some((comment) => comment.body.includes("PROVIDER_QUOTA_OR_AUTH_403"))).toBe(true);
    expect(childComments.some((comment) => comment.body.includes("mimo26pro"))).toBe(true);
    const parentComments = await db.select().from(issueComments).where(eq(issueComments.issueId, parentIssueId));
    expect(parentComments.some((comment) => comment.body.includes("Mission oversight: worker run failure observed"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: childIssueId }),
        expect.objectContaining({ action: "mission.worker_run_failure_observed", entityType: "mission", entityId: missionId }),
      ]),
    );
    expect(JSON.stringify(activities.map((activity) => activity.details))).toContain("PROVIDER_QUOTA_OR_AUTH_403");
  });
}
