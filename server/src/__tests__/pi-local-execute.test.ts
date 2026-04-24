import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');

if (process.argv.includes('--list-models')) {
  console.log('provider  model');
  console.log('openai    gpt-4.1-mini');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin }, null, 2), 'utf8');
  }
  console.log(JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: new Date().toISOString(), cwd: process.cwd() }));
  console.log(JSON.stringify({ type: 'agent_start' }));
  console.log(JSON.stringify({ type: 'turn_start' }));
  console.log(JSON.stringify({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } }
    },
    toolResults: []
  }));
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  stdin: string;
};

describe("pi execute", () => {
  it("injects the shared runtime brief instead of raw handoff markdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Coder",
          adapterType: "pi_local",
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
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
          provider: "openai",
          model: "openai/gpt-4.1-mini",
        },
        context: {
          paperclipStepInputManifest: {
            version: 1,
            taskKey: "issue:123",
            issueId: "issue-1",
            projectId: null,
            allowedContextKeys: ["issueId", "paperclipSessionHandoff"],
            guardrails: { broadScanAllowed: false },
            inputs: {
              workspace: { available: true, source: "project_primary", workspaceId: "ws-1", projectId: null },
              workspaceHints: { available: false, count: 0 },
              runtimeServiceIntents: { available: false, count: 0 },
              runtimeServices: { available: false, count: 0, primaryUrl: null },
              sessionHandoff: { available: true, previousSessionId: "sess-1", rotationReason: "budget" },
            },
          },
          paperclipSessionHandoff: {
            version: 1,
            previousSessionId: "sess-1",
            previousRunId: "run-prev",
            issueId: "issue-1",
            rotationReason: "budget",
            lastRunSummaryText: "Last run summarized the issue state",
          },
          paperclipSessionHandoffMarkdown: "# raw handoff markdown should not appear",
        },
        authToken: undefined,
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.stdin).toContain("Paperclip runtime brief:");
      expect(capture.stdin).toContain("Previous session: sess-1");
      expect(capture.stdin).not.toContain("# raw handoff markdown should not appear");
      expect(invocationPrompt).toContain("Paperclip runtime brief:");
      expect(invocationPrompt).not.toContain("# raw handoff markdown should not appear");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
