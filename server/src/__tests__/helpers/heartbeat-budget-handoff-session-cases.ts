import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, heartbeatRuns, agentTaskSessions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatHandoffSessionCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("attaches a structured session handoff artifact alongside markdown when compaction rotates the session", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:handoff";
    const previousRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Handoff",
      issuePrefix: "PHO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Handoff Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Continue the assigned work.",
      },
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxRawInputTokens: 1,
          },
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      contextSnapshot: { taskKey },
      sessionIdAfter: "sess-1",
      usageJson: { rawInputTokens: 100 },
      resultJson: { summary: "Last run summarized the issue state" },
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      createdAt: new Date("2026-04-10T00:05:00.000Z"),
      updatedAt: new Date("2026-04-10T00:05:00.000Z"),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "sess-1", cwd: process.cwd() },
      sessionDisplayId: "sess-1",
      lastRunId: previousRunId,
    });

    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipSessionHandoffMarkdown).toContain("Previous session: sess-1");
    expect(invocationContext?.paperclipSessionHandoff).toEqual({
      version: 1,
      previousSessionId: "sess-1",
      previousRunId,
      issueId: null,
      rotationReason: "session raw input reached 100 tokens (threshold 1)",
      lastRunSummaryText: "Last run summarized the issue state",
    });
    expect(finalized.contextSnapshot?.paperclipSessionHandoff).toEqual(invocationContext?.paperclipSessionHandoff);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            sessionCompaction: {
              enabled: true,
              maxRawInputTokens: 0,
            },
          },
        },
      })
      .where(eq(agents.id, agentId));

    let secondInvocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementationOnce(async ({ context }) => {
      secondInvocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const secondRun = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(secondRun).not.toBeNull();
    const secondFinalized = await waitForRunTerminal(heartbeat, secondRun!.id);
    expect(secondFinalized.status).toBe("succeeded");
    expect(secondInvocationContext?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondInvocationContext?.paperclipSessionHandoff).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoff).toBeUndefined();
  });
}
