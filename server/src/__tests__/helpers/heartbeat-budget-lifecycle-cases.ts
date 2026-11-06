import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, companies, issueComments, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatLifecycleCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, mockedAdapterOptions, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("injects local agent JWT as PAPERCLIP_API_KEY for adapters that support local agent auth", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;
    let invocationAgentConfig: Record<string, unknown> | undefined;

    mockedAdapterOptions.supportsLocalAgentJwt = true;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-local-agent-jwt-secret";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes API Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-AUTH",
      title: "Finalize through Paperclip API",
      description: "Use Paperclip API to comment and complete this issue.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ config, agent, authToken }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      invocationAgentConfig = structuredClone(agent.adapterConfig) as Record<string, unknown>;
      expect(authToken).toEqual(expect.any(String));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
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
    const configEnv = invocationConfig?.env as Record<string, unknown> | undefined;
    const agentEnv = invocationAgentConfig?.env as Record<string, unknown> | undefined;
    expect(configEnv?.PAPERCLIP_API_KEY).toEqual(expect.any(String));
    expect(agentEnv?.PAPERCLIP_API_KEY).toBe(configEnv?.PAPERCLIP_API_KEY);
    expect(String(configEnv?.PAPERCLIP_API_KEY).split(".")).toHaveLength(3);
  });

  it("auto-completes a successful checked-out issue when the run exits without PATCHing status", async () => {
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
      name: "Lifecycle Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Work the checked out issue." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-LIFE",
      title: "Issue lifecycle must be explicit",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "I completed this in the run, but did not PATCH the issue status.",
      });
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
    expect(comments.some((comment) => comment.body.includes("checked-out run succeeded"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "issue.run_succeeded_auto_completed",
          entityType: "issue",
          entityId: issueId,
        }),
      ]),
    );
  });

  it("closes a checked-out mission_main_executor_unblock issue via the guarded handback route (not raw tx.done), preserving the owner-recovery happy path", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const unblockIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip GAZ315 Guard",
      issuePrefix: "GZ",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Owner Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Work the checked out unblock issue." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "GAZ-315 guard mission", status: "active" });
    await db.insert(issues).values({
      id: sourceIssueId, companyId, missionId, identifier: "GZ-SRC", title: "blocked source",
      status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution",
    });
    await db.insert(issues).values({
      id: unblockIssueId, companyId, missionId, identifier: "GZ-UNB", title: "unblock action",
      status: "in_progress", assigneeAgentId: agentId,
      originKind: "mission_main_executor_unblock", originId: sourceIssueId,
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, unblockIssueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${unblockIssueId}`, issueId: unblockIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    // [happy path preserved] the unblock issue still reaches done after the owner run succeeds — but
    //   now via the guarded handback route, not a raw tx.update(done).
    await waitForIssueStatus(db, unblockIssueId, (issue) => issue.status === "done");

    // [guard fired, not bypassed] a validated structured handback report must exist on the unblock
    //   issue (sourceIssueId === originId) — proving closeout went through assertCanCompleteOwnerActionWithHandback.
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, unblockIssueId));
    expect(comments.some((c) =>
      typeof c.body === "string" &&
      c.body.startsWith("[owner-action-handback-report]") &&
      c.body.includes(`sourceIssueId: ${sourceIssueId}`) &&
      c.body.includes("evidence:"),
    )).toBe(true);

    // source status unchanged (no direct checkout/status mutation).
    const [sourceAfter] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, sourceIssueId)).limit(1);
    expect(sourceAfter?.status).toBe("blocked");
  });
}
