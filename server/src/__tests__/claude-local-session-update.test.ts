import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-test" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "done", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, total_cost_usd: 0.01 }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("claude execute session updates", () => {
  it("removes stale pyenv shim locks before launching Claude", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-pyenv-lock-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const pyenvRoot = path.join(root, "pyenv");
    const lockPath = path.join(pyenvRoot, "shims", ".pyenv-shim");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "stale", "utf8");
    await fs.utimes(lockPath, new Date(0), new Date(0));
    await writeFakeClaudeCommand(commandPath);

    try {
      const logs: string[] = [];
      const result = await execute({
        runId: "run-claude-pyenv-lock",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
          env: {
            PYENV_ROOT: pyenvRoot,
            PAPERCLIP_PYENV_SHIM_LOCK_STALE_MS: "0",
          },
        },
        context: {},
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

      expect(result.exitCode).toBe(0);
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(logs.join("")).toContain("Removed stale pyenv shim lock before Claude launch");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an early session update when Claude reports system init", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-session-update-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const sessionUpdates: unknown[] = [];
      const result = await execute({
        runId: "run-claude-session-update",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        onLog: async () => {},
        onSessionUpdate: async (update) => {
          sessionUpdates.push(update);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(sessionUpdates).toEqual([
        expect.objectContaining({
          sessionId: "claude-session-1",
          sessionDisplayId: "claude-session-1",
          source: "stdout",
          confidence: "provider_reported",
          sessionParams: expect.objectContaining({
            sessionId: "claude-session-1",
            cwd: workspace,
          }),
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adds planning-run tool restrictions while preserving Bash for Paperclip API/status work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-planning-tools-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      let commandArgs: string[] = [];
      let invocationPrompt = "";
      let commandNotes: string[] = [];
      const result = await execute({
        runId: "run-claude-planning-tools",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Research Director",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          paperclipStepInputManifest: {
            version: 1,
            taskKey: "mission:mission-1",
            issueId: "issue-plan-1",
            projectId: null,
            allowedContextKeys: ["paperclipMissionOwnerPlanningContext"],
            guardrails: { broadScanAllowed: false },
            inputs: {
              runtimeServices: { available: false, count: 0, primaryUrl: null },
              missionOwnerPlanningContext: {
                available: true,
                missionId: "mission-1",
                planningIssueId: "issue-plan-1",
                activePlanAvailable: false,
                selectedExecutionUnitCount: 0,
                executionSourceUnitCount: 0,
                planningDossierAssetCounts: {
                  workflowCandidates: 0,
                  tools: 0,
                  runtimeServices: 0,
                  ruleRefs: 0,
                  kbRefs: 0,
                  agentRoster: 1,
                  fileViews: 0,
                  executionSourceUnits: 0,
                },
                planningDossierGapCount: 1,
                planningDossierSevereGapCount: 1,
              },
            },
          },
        },
        onLog: async () => {},
        onMeta: async (meta) => {
          commandArgs = meta.commandArgs ?? [];
          invocationPrompt = meta.prompt ?? "";
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(commandArgs).toContain("--disallowedTools");
      expect(commandArgs[commandArgs.indexOf("--disallowedTools") + 1]).toBe("WebSearch,WebFetch,Task");
      expect(commandArgs[commandArgs.indexOf("--disallowedTools") + 1]).not.toContain("Bash");
      expect(commandNotes.join("\n")).toContain("Director/mission-owner planning run tool restriction");
      expect(invocationPrompt).toContain("Director boundary:");
      expect(invocationPrompt).toContain("internal Agent/Task/WebSearch/WebFetch/Bash as a source-research or report-production substitute");
      expect(invocationPrompt).toContain("No runtime service assets are listed in this dossier. This is not a Paperclip worker-runtime health signal.");
      expect(invocationPrompt).not.toContain("Runtime services: unavailable");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
