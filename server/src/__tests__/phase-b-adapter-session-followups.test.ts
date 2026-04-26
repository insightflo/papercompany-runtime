import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute as executeGemini } from "@paperclipai/adapter-gemini-local/server";
import { execute as executeOpenCode } from "@paperclipai/adapter-opencode-local/server";
import { execute as executeCursor } from "@paperclipai/adapter-cursor-local/server";

async function writeFakeCommand(commandPath: string, scriptBody: string): Promise<void> {
  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  await fs.chmod(commandPath, 0o755);
}

function baseContext(adapterType: string, workspace: string) {
  return {
    runId: `run-${adapterType}`,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Phase B Tester",
      adapterType,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: workspace,
      promptTemplate: "Follow the paperclip heartbeat.",
    },
    context: {},
    onLog: async () => {},
  };
}

describe("Phase B adapter session follow-ups", () => {
  it("emits an early session update when Gemini reports a stream session id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-session-update-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCommand(commandPath, [
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'gemini-session-1' }));",
      "console.log(JSON.stringify({ type: 'assistant', session_id: 'gemini-session-1', message: { text: 'hello' } }));",
      "console.log(JSON.stringify({ type: 'result', session_id: 'gemini-session-1', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }));",
    ].join("\n"));

    try {
      const sessionUpdates: unknown[] = [];
      const result = await executeGemini({
        ...baseContext("gemini_local", workspace),
        config: {
          ...baseContext("gemini_local", workspace).config,
          command: commandPath,
        },
        onSessionUpdate: async (update) => {
          sessionUpdates.push(update);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(sessionUpdates).toEqual([
        expect.objectContaining({
          sessionId: "gemini-session-1",
          sessionDisplayId: "gemini-session-1",
          source: "stdout",
          confidence: "provider_reported",
          sessionParams: expect.objectContaining({
            sessionId: "gemini-session-1",
            cwd: workspace,
          }),
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an early session update when OpenCode reports sessionID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-session-update-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCommand(commandPath, [
      "if (process.argv[2] === 'models') { console.log('openai/gpt-test'); process.exit(0); }",
      "console.log(JSON.stringify({ type: 'session', sessionID: 'opencode-session-1' }));",
      "console.log(JSON.stringify({ type: 'text', sessionID: 'opencode-session-1', part: { text: 'hello' } }));",
      "console.log(JSON.stringify({ type: 'step_finish', sessionID: 'opencode-session-1', part: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0 } }, cost: 0 } }));",
    ].join("\n"));

    try {
      const sessionUpdates: unknown[] = [];
      const result = await executeOpenCode({
        ...baseContext("opencode_local", workspace),
        config: {
          ...baseContext("opencode_local", workspace).config,
          command: commandPath,
          model: "openai/gpt-test",
        },
        onSessionUpdate: async (update) => {
          sessionUpdates.push(update);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(sessionUpdates).toEqual([
        expect.objectContaining({
          sessionId: "opencode-session-1",
          sessionDisplayId: "opencode-session-1",
          source: "stdout",
          confidence: "provider_reported",
          sessionParams: expect.objectContaining({
            sessionId: "opencode-session-1",
            cwd: workspace,
          }),
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an early session update when Cursor reports a stream session id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-session-update-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCommand(commandPath, [
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session-1' }));",
      "console.log(JSON.stringify({ type: 'assistant', session_id: 'cursor-session-1', message: { text: 'hello' } }));",
      "console.log(JSON.stringify({ type: 'result', session_id: 'cursor-session-1', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }));",
    ].join("\n"));

    try {
      const sessionUpdates: unknown[] = [];
      const result = await executeCursor({
        ...baseContext("cursor", workspace),
        config: {
          ...baseContext("cursor", workspace).config,
          command: commandPath,
        },
        onSessionUpdate: async (update) => {
          sessionUpdates.push(update);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(sessionUpdates).toEqual([
        expect.objectContaining({
          sessionId: "cursor-session-1",
          sessionDisplayId: "cursor-session-1",
          source: "stdout",
          confidence: "provider_reported",
          sessionParams: expect.objectContaining({
            sessionId: "cursor-session-1",
            cwd: workspace,
          }),
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
