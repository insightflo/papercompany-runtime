import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatManifestWorkspaceCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("persists executionWorkspaceId in the manifest before adapter execution", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workspace",
      issuePrefix: "PWX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Project",
      status: "backlog",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Workspace issue",
      status: "todo",
    });

    const heartbeat = heartbeatService(db);
    executeSpy.mockImplementation(async ({ runId, context }) => {
      const persisted = await heartbeat.getRun(runId);
      expect(persisted?.issueId).toBe(issueId);
      const persistedContext = persisted?.contextSnapshot ?? {};
      expect(persistedContext.executionWorkspaceId).toBeTruthy();
      expect(persistedContext.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
      expect(context.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
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

    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
  });

  it("refreshes the manifest after a same-task wake is coalesced into a running run", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:coalesced";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coalesced Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {
        taskKey,
        paperclipStepInputManifest: {
          version: 1,
          taskKey,
          issueId: null,
          projectId: null,
          allowedContextKeys: ["taskKey"],
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
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.invoke(agentId, "on_demand", { taskKey, note: "coalesced note" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(mergedRun).not.toBeNull();
    expect(mergedRun?.id).toBe(existingRunId);
    expect(executeSpy).not.toHaveBeenCalled();
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["note", "taskKey", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("refreshes the manifest for issue-execution same-agent coalesced wakes", async () => {
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

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
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
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "todo",
      executionRunId: existingRunId,
      executionAgentNameKey: "execution agent",
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "issue-exec note" },
    });

    expect(mergedRun?.id).toBe(existingRunId);
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });
}
