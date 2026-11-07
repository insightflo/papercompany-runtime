import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatWakeupAssigneeCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForWakeupRequestStatus }: HeartbeatBudgetCaseContext) {
  it("retries a failed issue run on the issue's current assignee instead of the original run agent", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const originalAgentId = randomUUID();
    const currentAssigneeId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Scout Agent",
        role: "researcher",
        status: "active",
        adapterType: "antigravity_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: currentAssigneeId,
        companyId,
        name: "Hermes Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry should follow reassignment",
      status: "todo",
      assigneeAgentId: currentAssigneeId,
    });

    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    const retriedRun = await heartbeat.wakeup(originalAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId },
    });

    expect(retriedRun?.agentId).toBe(currentAssigneeId);
    const request = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, retriedRun!.id))
      .then((rows) => rows[0] ?? null);
    expect(request?.agentId).toBe(currentAssigneeId);
    const issue = await db
      .select({ executionRunId: issues.executionRunId, executionAgentNameKey: issues.executionAgentNameKey })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toEqual(
      expect.objectContaining({
        executionRunId: retriedRun!.id,
        executionAgentNameKey: "hermes research agent",
      }),
    );
    await waitForRunTerminal(heartbeat, retriedRun!.id);
  });

  it("completes the wakeup request when a run is terminalized before the adapter returns", async () => {
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
      name: "Execution Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue completed before child exits",
      status: "todo",
      assigneeAgentId: agentId,
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      const finishedAt = new Date();
      await db
        .update(issues)
        .set({
          status: "done",
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: finishedAt,
          updatedAt: finishedAt,
        })
        .where(eq(issues.id, issueId));
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt,
          error: "Issue done but adapter child did not exit; terminated",
          errorCode: "issue_done_child_not_exited",
          updatedAt: finishedAt,
        })
        .where(eq(heartbeatRuns.id, runId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: { issueId },
    });
    expect(run).not.toBeNull();

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(finalized.errorCode).toBe("issue_done_child_not_exited");

    const request = await waitForWakeupRequestStatus(
      db,
      run!.id,
      (candidate) => candidate.status === "completed",
    );
    expect(request).toEqual(expect.objectContaining({
      status: "completed",
      error: "Issue done but adapter child did not exit; terminated",
    }));
    expect(request?.finishedAt).toBeInstanceOf(Date);
  });

  it("refreshes the manifest inside deferred issue-execution wake payloads", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runningRunId = randomUUID();
    const deferredId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deferred Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred issue",
      status: "todo",
      executionRunId: runningRunId,
      executionAgentNameKey: "someone-else",
      executionLockedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          paperclipStepInputManifest: {
            version: 1,
            taskKey: issueId,
            issueId,
            projectId: null,
            allowedContextKeys: ["issueId"],
            guardrails: { broadScanAllowed: false },
            inputs: {
              workspace: { available: false, source: null, workspaceId: null, projectId: null },
              workspaceHints: { available: false, count: 0 },
              runtimeServiceIntents: { available: false, count: 0 },
              runtimeServices: { available: false, count: 0, primaryUrl: null },
              sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
            },
          },
        },
      },
      status: "deferred_issue_execution",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "deferred note" },
    });

    expect(result).toBeNull();
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredId))
      .then((rows) => rows[0] ?? null);
    expect(deferred).not.toBeNull();
    expect(deferred?.coalescedCount).toBe(1);
    const deferredContext = (deferred?.payload as Record<string, unknown>)._paperclipWakeContext as Record<string, unknown>;
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(deferredContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });
}
