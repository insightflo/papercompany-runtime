import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatAdapterFallbackCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, failedAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("does not queue the same adapter fallback again after a provider model parameter failure", async () => {
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
      name: "Fallback Guard",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {
        command: "primary-agent",
        fallbackCommand: "fallback-agent",
        fallback: { maxAttempts: 2, triggers: ["exit_error"] },
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Run guarded fallback",
      status: "todo",
      assigneeAgentId: agentId,
    });

    executeSpy.mockImplementationOnce(async () =>
      failedAdapterResult({
        errorMessage: "Claude run failed: subtype=success: API Error: 400 Param Incorrect",
        provider: "anthropic",
        model: "mimo-v2.5-pro-ultraspeeed[1m]",
        resultJson: {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 400,
          result: "API Error: 400 Param Incorrect",
        },
      }),
    );

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      {
        taskKey: `issue:${issueId}`,
        issueId,
        wakeReason: "adapter_fallback",
        fallbackOfRunId: randomUUID(),
        fallbackAttempt: 1,
        fallbackCommand: "fallback-agent",
      },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");

    const fallbackRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, finalized.id));
    expect(fallbackRuns).toHaveLength(0);

    const deadline = Date.now() + 1_000;
    let sawSuppressedEvent = false;
    while (Date.now() < deadline && !sawSuppressedEvent) {
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finalized.id));
      sawSuppressedEvent = events.some((event) => event.message.includes("adapter fallback suppressed"));
      if (!sawSuppressedEvent) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sawSuppressedEvent).toBe(true);
  });

  it("queues adapter fallback when adapter execution throws before returning a result", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let fallbackConfig: Record<string, unknown> | null = null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Throw",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {
        command: "opencode",
        model: "zai-coding-plan/glm-5.2",
        fallback: {
          command: "opencode",
          model: "openai/gpt-5.4-mini",
          maxAttempts: 1,
          triggers: ["run_failed"],
        },
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Run fallback after adapter throw",
      status: "todo",
      assigneeAgentId: agentId,
    });

    executeSpy
      .mockImplementationOnce(async () => {
        throw new Error("`opencode models` timed out after 20s.");
      })
      .mockImplementationOnce(async ({ config }) => {
        fallbackConfig = structuredClone(config) as Record<string, unknown>;
        return successfulAdapterResult();
      });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, wakeReason: "assignment" },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("opencode models");

    const deadline = Date.now() + 5_000;
    let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
    while (Date.now() < deadline && !fallbackRun) {
      fallbackRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, finalized.id))
        .then((rows) => rows[0] ?? null);
      if (!fallbackRun) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(fallbackRun).toBeTruthy();
    expect(fallbackRun?.contextSnapshot).toMatchObject({
      fallbackOfRunId: finalized.id,
      fallbackReason: "run_failed",
      fallbackAttempt: 1,
      fallbackCommand: "opencode",
      fallbackModel: "openai/gpt-5.4-mini",
      wakeReason: "adapter_fallback",
    });

    const fallbackFinalized = await waitForRunTerminal(heartbeat, fallbackRun!.id);
    expect(fallbackFinalized.status).toBe("succeeded");
    expect(fallbackConfig).toMatchObject({
      command: "opencode",
      model: "openai/gpt-5.4-mini",
    });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finalized.id));
    expect(events.some((event) => event.message.includes("queued fallback"))).toBe(true);
  });
}
