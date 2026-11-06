import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatBroadScanInterceptionCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal, expectBroadScanInterception }: HeartbeatBudgetCaseContext) {
  it("blocks explicit broad-scan prompts when the manifest forbids them", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:broad-scan";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_blocked");
    expect(finalized.error).toContain("scan the entire repo");
  });

  it("intercepts a live broad-scan tool call and continues the run (hook injects synthetic output)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog("stdout", `${JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "find . -type f",
          status: "in_progress",
        },
      })}\n`);
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
    // Runtime broad-scan tool calls are now INTERCEPTED by the hook (a synthetic
    // in-scope output is injected) instead of killing the run — the run succeeds.
    expect(finalized.status).toBe("succeeded");
    expect(finalized.errorCode).not.toBe("manifest_broad_scan_tool_blocked");
    await expectBroadScanInterception(db, finalized.id);
  });

  it("intercepts a chunk-split broad-scan tool call after the full JSON line is reconstructed", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-split";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "gemini_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shell: {
          command: "find . -type f",
        },
      },
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      const midpoint = Math.floor(line.length / 2);
      await onLog("stdout", line.slice(0, midpoint));
      await onLog("stdout", `${line.slice(midpoint)}\n`);
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
    // Runtime broad-scan tool calls are now INTERCEPTED (hook injects a synthetic
    // in-scope output) instead of killing the run — the run succeeds.
    expect(finalized.status).toBe("succeeded");
    expect(finalized.errorCode).not.toBe("manifest_broad_scan_tool_blocked");
    await expectBroadScanInterception(db, finalized.id);
  });

  it("intercepts a cursor shell tool call when normalized JSONL arrives on stderr", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-cursor-stderr";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog(
        "stderr",
        `${JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_1",
          tool_call: {
            shellToolCall: {
              command: "find . -type f",
            },
          },
        })}\n`,
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

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    // Runtime broad-scan tool calls are now INTERCEPTED (hook injects a synthetic
    // in-scope output) instead of killing the run — the run succeeds.
    expect(finalized.status).toBe("succeeded");
    expect(finalized.errorCode).not.toBe("manifest_broad_scan_tool_blocked");
    await expectBroadScanInterception(db, finalized.id);
  });
}
