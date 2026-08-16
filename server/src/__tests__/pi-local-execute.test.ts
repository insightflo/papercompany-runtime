import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

type FakeMode = "settle" | "no-settled" | "noop";

async function writeFakePiCommand(commandPath: string, mode: FakeMode = "settle"): Promise<void> {
  // Mirrors real pi --mode rpc semantics (verified against pi 0.84.1):
  // - "settle": prompt arrives on stdin, the model turn emits events
  //   asynchronously (turn_end -> agent_end willRetry=false -> agent_settled),
  //   and pi exits at stdin EOF. If EOF arrives before the turn ran, pi exits 0
  //   without any turn events — the no-op run bug.
  // - "no-settled": same, but omits agent_settled (older pi builds) so the
  //   adapter must fall back to closing stdin after the final agent_end.
  // - "noop": exits 0 without emitting any events (no model turn ran at all).
  const emitBlock =
    mode === "noop"
      ? `// noop mode: exit 0 without emitting any events (no model turn ran).
setTimeout(() => {
  writeCapture({ emittedBeforeEof: false });
  process.exit(0);
}, 100);`
      : `setTimeout(() => {
  if (stdinEnded) {
    // EOF already arrived before the model turn started — real pi exits here
    // without a turn (the bug this regression test guards against).
    writeCapture({ emittedBeforeEof: false });
    return;
  }
  emitted = true;
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
  console.log(JSON.stringify({ type: 'agent_end', willRetry: false }));${
    mode === "settle" ? `\n  console.log(JSON.stringify({ type: 'agent_settled' }));` : ""
  }
}, 30);`;

  const script = `#!/usr/bin/env node
const fs = require('node:fs');

if (process.argv.includes('--list-models')) {
  console.log('provider  model');
  console.log('openai    gpt-4.1-mini');
  process.exit(0);
}

let stdin = '';
let stdinEnded = false;
let emitted = false;
let wroteCapture = false;
const capturePath = process.env.ADAPTER_TEST_CAPTURE_PATH;
const writeCapture = (extra) => {
  if (wroteCapture || !capturePath) return;
  wroteCapture = true;
  fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin, ...extra }, null, 2), 'utf8');
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  stdinEnded = true;
  writeCapture({ emittedBeforeEof: emitted });
});
${emitBlock}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  stdin: string;
  emittedBeforeEof?: boolean;
};

type ExecuteCtx = Parameters<typeof execute>[0];

function buildCtx(opts: {
  command: string;
  cwd: string;
  capturePath: string;
  onMeta?: ExecuteCtx["onMeta"];
}): ExecuteCtx {
  return {
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
      command: opts.command,
      cwd: opts.cwd,
      env: {
        ADAPTER_TEST_CAPTURE_PATH: opts.capturePath,
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
          runtimeServices: { available: false, count: 0 },
          primaryUrl: null,
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
    onMeta: opts.onMeta ?? (async () => {}),
  };
}

async function prepare(mode: FakeMode): Promise<{
  root: string;
  ctx: ExecuteCtx;
  capturePath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "pi");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await writeFakePiCommand(commandPath, mode);
  const ctx = buildCtx({ command: commandPath, cwd: workspace, capturePath });
  return { root, ctx, capturePath };
}

describe("pi execute", () => {
  it("injects the shared runtime brief instead of raw handoff markdown", async () => {
    let invocationPrompt = "";
    const { root, ctx, capturePath } = await prepare("settle");
    ctx.onMeta = async (meta) => {
      invocationPrompt = meta.prompt ?? "";
    };
    try {
      const result = await execute(ctx);

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      // Regression: stdin must stay open until the model turn emitted its
      // events (agent_settled) — an immediate stdin close makes the fake (like
      // real pi) exit before the turn, leaving emittedBeforeEof false.
      expect(capture.emittedBeforeEof).toBe(true);
      expect(capture.stdin).toContain("Paperclip runtime brief:");
      expect(capture.stdin).toContain("Previous session: sess-1");
      expect(capture.stdin).not.toContain("# raw handoff markdown should not appear");
      expect(invocationPrompt).toContain("Paperclip runtime brief:");
      expect(invocationPrompt).not.toContain("# raw handoff markdown should not appear");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to closing stdin after the final agent_end when agent_settled is absent", async () => {
    const { root, ctx, capturePath } = await prepare("no-settled");
    try {
      const result = await execute(ctx);

      // The fake only exits at stdin EOF: this asserts the adapter closed
      // stdin (fallback timer after final agent_end) and that it happened
      // after the turn events were emitted.
      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.emittedBeforeEof).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats an exit-0 run with zero assistant output as failure (no-op guard)", async () => {
    const { root, ctx } = await prepare("noop");
    try {
      const result = await execute(ctx);

      // Regression: exit 0 with no model turn must never be reported as
      // success — that masking hid every pi run since the adapter cutover.
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("without any assistant output");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
