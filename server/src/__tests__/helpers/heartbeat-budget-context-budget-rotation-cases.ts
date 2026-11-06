import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentInstructionInjections, companies } from "@paperclipai/db";
import { applyInstructionInjectionPolicy, loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatContextBudgetRotationCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForWakeupStatus, seedInstructionRotationFixture }: HeartbeatBudgetCaseContext) {
  it("blocks execution before adapter.execute when the estimated context budget is exceeded", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budgeted Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "x".repeat(400),
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 5,
          },
        },
      },
      permissions: {},
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [{ serviceName: "api", url: "http://localhost:4100", scopeType: "run", lifecycle: "ephemeral" }],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { note: "y".repeat(100) }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(finalized.error).toContain("exceeds budget");
    expect(finalized.wakeupRequestId).toBeTruthy();
    const wakeup = await waitForWakeupStatus(db, finalized.wakeupRequestId!, "failed");
    expect(wakeup?.status).toBe("failed");
  });

  it("restores full instructions before a context-budget session rotation and does not consume the ledger", async () => {
    const db = getDb();
    const fixture = await seedInstructionRotationFixture({ maxEstimatedChars: 1, staleFile: false });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { taskKey: fixture.taskKey, issueId: fixture.issueId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.contextSnapshot?.paperclipSessionRotationReason).toBe("context_budget_preflight");
    expect(finalized.contextSnapshot?.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    const [ledger] = await db.select().from(agentInstructionInjections);
    expect(ledger?.injectionCount).toBe(1);
    expect(ledger?.lastInjectionJson).toMatchObject({ deliveryToken: "seed-delivery" });
  });

  it("reruns the context budget with full instructions after file-view staleness rotation", async () => {
    const db = getDb();
    const fixture = await seedInstructionRotationFixture({ maxEstimatedChars: 20_000, staleFile: true });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { taskKey: fixture.taskKey, issueId: fixture.issueId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.contextSnapshot?.paperclipSessionRotationReason).toBe("file_view_stale");
    expect(finalized.contextSnapshot?.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    const [ledger] = await db.select().from(agentInstructionInjections);
    expect(ledger?.injectionCount).toBe(1);
    expect(ledger?.lastInjectionJson).toMatchObject({ deliveryToken: "seed-delivery" });
  });

  it("delivers and commits full instructions to the fresh session after file-view rotation", async () => {
    const db = getDb();
    const fixture = await seedInstructionRotationFixture({ maxEstimatedChars: 100_000, staleFile: true });
    let invocationContext: Record<string, unknown> | null = null;
    executeSpy.mockImplementationOnce(async ({ config, context, onSpawn }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      const loaded = await loadInstructionsWithInlinedReferences(String(config.instructionsFilePath));
      applyInstructionInjectionPolicy(loaded, context);
      await onSpawn({ pid: 12345, startedAt: new Date().toISOString() });
      return {
        ...successfulAdapterResult(),
        sessionId: "fresh-after-staleness",
        sessionDisplayId: "fresh-after-staleness",
        sessionParams: { sessionId: "fresh-after-staleness", cwd: config.cwd },
      };
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "assignment",
      { taskKey: fixture.taskKey, issueId: fixture.issueId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipSessionRotationReason).toBe("file_view_stale");
    expect(invocationContext?.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    expect(finalized.contextSnapshot?.paperclipInstructionInjection).toMatchObject({ mode: "full" });
    const [ledger] = await db.select().from(agentInstructionInjections);
    expect(ledger?.injectionCount).toBe(1);
    expect(ledger?.lastInjectionJson).toMatchObject({
      providerSessionId: "fresh-after-staleness",
      mode: "full",
    });
    expect(ledger?.lastInjectionJson.deliveryToken).not.toBe("seed-delivery");
  });
}
