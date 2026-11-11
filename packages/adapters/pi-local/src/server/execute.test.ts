import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { withChildProcessStartBoundary, type ChildProcessStartScope } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { resetPiModelsCacheForTests } from "./models.js";
import { resetPiSkillsInjectCacheForTests } from "./execute.js";
import { resetPiRateLimitGateForTests } from "./rate-limit-backoff.js";

async function writeFakePi(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--list-models")) {
  process.stdout.write("provider  model\\n");
  process.stdout.write("test  model\\n");
  process.exit(0);
}
const capturePath = process.env.PI_TEST_CAPTURE_PATH;
const attemptPath = process.env.PI_TEST_ATTEMPT_PATH;
const holdMs = Number(process.env.PI_TEST_HOLD_MS || "25");
// Real pi (rpc mode) consumes the prompt without stdin EOF; the adapter holds
// stdin open until the run settles, so read stdin asynchronously and proceed
// once the prompt chunk arrives (debounced for split writes).
let input = "";
let proceedTimer = null;
const proceed = () => {
  let sessionContentAtStart = null;
  if (process.env.PI_TEST_SESSION_FILE) {
    try { sessionContentAtStart = fs.readFileSync(process.env.PI_TEST_SESSION_FILE, "utf8"); } catch {}
  }
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({
      argv,
      input,
      apiKey: process.env.PAPERCLIP_API_KEY,
      agentId: process.env.PAPERCLIP_AGENT_ID,
      runId: process.env.PAPERCLIP_RUN_ID,
      providerKey: process.env.ANTHROPIC_API_KEY,
      home: process.env.HOME,
      sessionContentAtStart,
    }, null, 2));
  }
  let attempt = 1;
  if (attemptPath) {
    try { attempt = Number(fs.readFileSync(attemptPath, "utf8")) + 1; } catch {}
    fs.writeFileSync(attemptPath, String(attempt));
  }
  if (process.env.PI_TEST_UNKNOWN_SESSION === "1" && attempt === 1) {
    process.stderr.write("unknown session id\\n");
    process.exit(1);
  }
  const rateLimitAttemptEquals = Number(process.env.PI_TEST_RATE_LIMIT_ATTEMPT_EQUALS || "0");
  if (rateLimitAttemptEquals > 0 && attempt === rateLimitAttemptEquals) {
    if (process.env.PI_TEST_SESSION_FILE && process.env.PI_TEST_APPEND_429_TURN === "1") {
      fs.appendFileSync(process.env.PI_TEST_SESSION_FILE, JSON.stringify({ type: "auto_retry_end", success: false, finalError: "429: broken rate-limit turn" }) + "\\n");
      fs.writeFileSync(process.env.PI_TEST_SESSION_FILE + ".429-appended", "1");
    }
    process.stdout.write(JSON.stringify({
      type: "auto_retry_end",
      success: false,
      finalError: "429: {\\"code\\":\\"1302\\",\\"message\\":\\"Rate limit reached for requests\\"}",
    }) + "\\n");
    process.exit(1);
  }
  if (process.env.PI_TEST_RATE_LIMIT_AFTER_TOOLCALL === "1") {
    process.stdout.write(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo hi" },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-1",
      result: "hi",
      isError: false,
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "auto_retry_end",
      success: false,
      finalError: "429: {\\"code\\":\\"1302\\",\\"message\\":\\"Rate limit reached for requests\\"}",
    }) + "\\n");
    process.exit(1);
  }
  if (process.env.PI_TEST_STRUCTURED_ERROR === "1") {
    process.stdout.write(JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        status: "error",
        stopReason: "error",
        errorMessage: "structured provider failure",
      },
    }) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "fake pi response" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_end", willRetry: false }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (proceedTimer) clearTimeout(proceedTimer);
  proceedTimer = setTimeout(proceed, holdMs);
});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

function buildContext(input: {
  command: string;
  cwd: string;
  home: string;
  capturePath: string;
  attemptPath?: string;
  authToken?: string;
  explicitApiKey?: string;
  providerApiKey?: string;
  unknownSession?: boolean;
  structuredError?: boolean;
  rateLimitAttemptEquals?: number;
  rateLimitAfterToolCall?: boolean;
  sessionFile?: string;
  append429Turn?: boolean;
  timeoutSec?: number;
  logs?: string[];
  runtime?: AdapterExecutionContext["runtime"];
  context?: Record<string, unknown>;
  holdMs?: number;
}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pi worker",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: input.runtime ?? {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: input.command,
      cwd: input.cwd,
      model: "test/model",
      env: {
        HOME: input.home,
        PI_TEST_CAPTURE_PATH: input.capturePath,
        ...(input.attemptPath ? { PI_TEST_ATTEMPT_PATH: input.attemptPath } : {}),
        ...(input.unknownSession ? { PI_TEST_UNKNOWN_SESSION: "1" } : {}),
        ...(input.structuredError ? { PI_TEST_STRUCTURED_ERROR: "1" } : {}),
        ...(input.rateLimitAttemptEquals ? { PI_TEST_RATE_LIMIT_ATTEMPT_EQUALS: String(input.rateLimitAttemptEquals) } : {}),
        ...(input.rateLimitAfterToolCall ? { PI_TEST_RATE_LIMIT_AFTER_TOOLCALL: "1" } : {}),
        ...(input.sessionFile ? { PI_TEST_SESSION_FILE: input.sessionFile } : {}),
        ...(input.append429Turn ? { PI_TEST_APPEND_429_TURN: "1" } : {}),
        ...(input.explicitApiKey ? { PAPERCLIP_API_KEY: input.explicitApiKey } : {}),
        ...(input.providerApiKey ? { ANTHROPIC_API_KEY: input.providerApiKey } : {}),
        ...(input.holdMs ? { PI_TEST_HOLD_MS: String(input.holdMs) } : {}),
      },
      ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
    },
    context: input.context ?? {},
    authToken: input.authToken,
    onLog: input.logs
      ? async (_stream: "stdout" | "stderr", chunk: string) => {
          input.logs!.push(chunk);
        }
      : async () => {},
  };
}

describe("pi_local execute contract", () => {
  beforeEach(() => {
    resetPiModelsCacheForTests();
    resetPiSkillsInjectCacheForTests();
  });

  afterEach(() => {
    resetPiModelsCacheForTests();
    resetPiSkillsInjectCacheForTests();
  });

  it("passes authToken as PAPERCLIP_API_KEY and uses configured HOME for the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);

    try {
      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          authToken: "claimed-token",
        }),
      );
      const captured = JSON.parse(await fs.readFile(capture, "utf8")) as {
        argv: string[];
        input: string;
        apiKey?: string;
        home?: string;
      };

      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("fake pi response");
      expect(captured.apiKey).toBe("claimed-token");
      expect(captured.home).toBe(home);
      expect(captured.argv).toContain("--mode");
      expect(captured.argv).toContain("rpc");
      expect(captured.argv[captured.argv.indexOf("--session") + 1]).toContain(
        path.join(home, ".pi", "paperclips"),
      );
      expect(JSON.parse(captured.input)).toEqual({
        type: "prompt",
        message: expect.any(String),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the server auth token over configured Paperclip values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-key-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);

    try {
      await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          authToken: "claimed-token",
          explicitApiKey: "configured-token",
          providerApiKey: "provider-token",
        }),
      );
      const captured = JSON.parse(await fs.readFile(capture, "utf8")) as {
        apiKey?: string;
        agentId?: string;
        runId?: string;
        providerKey?: string;
      };
      expect(captured.apiKey).toBe("claimed-token");
      expect(captured.agentId).toBe("agent-1");
      expect(captured.runId).toBe("run-1");
      expect(captured.providerKey).toBe("provider-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes configured and inherited Paperclip credentials without server auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-no-auth-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    const inheritedApiKey = process.env.PAPERCLIP_API_KEY;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);
    process.env.PAPERCLIP_API_KEY = "inherited-token";

    try {
      await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          explicitApiKey: "configured-token",
        }),
      );
      const captured = JSON.parse(await fs.readFile(capture, "utf8")) as { apiKey?: string };
      expect(captured.apiKey).toBeUndefined();
    } finally {
      if (inheritedApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = inheritedApiKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Pi reports a structured assistant error with exit 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-error-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);

    try {
      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          structuredError: true,
        }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBe("structured provider failure");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits exactly one parseable pi-local-timing JSON log line per run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-timing-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);

    try {
      const ctx = buildContext({ command, cwd, home, capturePath: capture });
      const stderrChunks: string[] = [];
      ctx.onLog = async (stream, chunk) => {
        if (stream === "stderr") stderrChunks.push(chunk);
      };
      const result = await execute(ctx);

      expect(result.exitCode).toBe(0);
      const timingLines = stderrChunks
        .join("")
        .split("\n")
        .filter((line) => line.includes("pi-local-timing"));
      expect(timingLines).toHaveLength(1);

      const parsed = JSON.parse(timingLines[0]) as Record<string, unknown>;
      expect(parsed.type).toBe("pi-local-timing");
      expect(typeof parsed.skillsInjectMs).toBe("number");
      expect(typeof parsed.modelCheckMs).toBe("number");
      expect(typeof parsed.modelCacheHit).toBe("boolean");
      expect(typeof parsed.sessionResolveMs).toBe("number");
      expect(typeof parsed.promptAssembleMs).toBe("number");
      expect(typeof parsed.spawnMs).toBe("number");
      expect(typeof parsed.firstEventMs).toBe("number");
      expect(typeof parsed.settledMs).toBe("number");
      expect(typeof parsed.exitMs).toBe("number");
      expect(typeof parsed.parseMs).toBe("number");
      expect(typeof parsed.totalMs).toBe("number");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns the fresh session after an unknown-session retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-session-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    const attempts = path.join(root, "attempts");
    const previousSession = path.join(home, ".pi", "paperclips", "old.jsonl");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(previousSession), { recursive: true });
    await fs.writeFile(previousSession, "", "utf8");
    await writeFakePi(command);

    try {
      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          unknownSession: true,
          runtime: {
            sessionId: previousSession,
            sessionParams: { sessionId: previousSession, cwd },
            sessionDisplayId: previousSession,
            taskKey: null,
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.clearSession).toBe(false);
      expect(result.sessionId).toBeTruthy();
      expect(result.sessionId).not.toBe(previousSession);
      expect(result.sessionId).toContain(path.join(home, ".pi", "paperclips"));
      expect(result.sessionParams).toEqual({ sessionId: result.sessionId, cwd });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects a queued operator interrupt into the live child stdin exactly once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-interrupt-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const agentHome = path.join(root, "agent-home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    const issueId = "99999999-9999-4999-8999-999999999999";
    const inboxPath = path.join(agentHome, "interrupts", `issue-${issueId}.json`);
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(path.dirname(inboxPath), { recursive: true });
    await fs.writeFile(
      inboxPath,
      JSON.stringify({
        commentId: "comment-42",
        body: "stop the wide scan now",
        createdAt: "2026-09-26T10:00:00.000Z",
        issueId,
      }),
      "utf8",
    );
    await writeFakePi(command);
    const previousPollMs = process.env.PAPERCLIP_OPERATOR_INTERRUPT_POLL_MS;
    process.env.PAPERCLIP_OPERATOR_INTERRUPT_POLL_MS = "40";

    try {
      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          holdMs: 300,
          context: {
            issueId,
            paperclipWorkspace: { cwd, source: "agent_home", agentHome },
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(await fs.readFile(capture, "utf8")) as { input: string };
      const lines = captured.input.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ type: "prompt", message: expect.any(String) });
      const interrupt = JSON.parse(lines[1]) as { type: string; message: string };
      expect(interrupt.type).toBe("prompt");
      expect(interrupt.message).toContain("[OPERATOR INTERRUPT — highest priority, act on this now]");
      expect(interrupt.message).toContain("stop the wide scan now");
      expect(interrupt.message).toContain("이 지시는 현재 작업 범위 내에서 우선 반영하라");
      // Exactly one interrupt line — the inbox file is consumed, not re-injected.
      expect(captured.input.split("OPERATOR INTERRUPT").length - 1).toBe(1);
      await expect(fs.access(inboxPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousPollMs === undefined) delete process.env.PAPERCLIP_OPERATOR_INTERRUPT_POLL_MS;
      else process.env.PAPERCLIP_OPERATOR_INTERRUPT_POLL_MS = previousPollMs;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("pi_local 429-1302 rate-limit backoff", () => {
  const RATE_LIMIT_ENV_KEYS = [
    "PAPERCLIP_PI_429_MAX_RETRIES",
    "PAPERCLIP_PI_429_BASE_DELAY_MS",
    "PAPERCLIP_PI_429_MAX_DELAY_MS",
    "PAPERCLIP_PI_429_STAGGER_MS",
  ] as const;
  let savedRateLimitEnv: Record<string, string | undefined>;

  beforeEach(() => {
    resetPiRateLimitGateForTests();
    savedRateLimitEnv = {};
    for (const key of RATE_LIMIT_ENV_KEYS) {
      savedRateLimitEnv[key] = process.env[key];
    }
    process.env.PAPERCLIP_PI_429_MAX_RETRIES = "2";
    process.env.PAPERCLIP_PI_429_BASE_DELAY_MS = "20";
    process.env.PAPERCLIP_PI_429_MAX_DELAY_MS = "90";
    process.env.PAPERCLIP_PI_429_STAGGER_MS = "10";
  });

  afterEach(() => {
    resetPiRateLimitGateForTests();
    for (const key of RATE_LIMIT_ENV_KEYS) {
      if (savedRateLimitEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedRateLimitEnv[key]!;
    }
  });

  const prepareRateLimitFixture = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-ratelimit-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");
    const command = path.join(root, "pi");
    const capture = path.join(root, "capture.json");
    const attempts = path.join(root, "attempts.txt");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakePi(command);
    return { root, cwd, home, command, capture, attempts };
  };

  const timingLineOf = (logs: string[]): Record<string, unknown> => {
    const line = logs.find((entry) => entry.includes('"pi-local-timing"'));
    expect(line).toBeDefined();
    return JSON.parse(line!) as Record<string, unknown>;
  };

  it("retries a 429-1302 failure after backoff on a fresh session and succeeds", async () => {
    const { root, cwd, home, command, capture, attempts } = await prepareRateLimitFixture();
    const logs: string[] = [];
    try {
      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          rateLimitAttemptEquals: 1,
          logs,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("fake pi response");
      // Attempt 1 failed with 429-1302; the backoff retry (attempt 2) succeeded.
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(2);
      expect(logs.join("")).toContain("rate limit 429 (code 1302) detected; backing off");
      const timing = timingLineOf(logs);
      expect(timing.rateLimitRetries).toBe(1);
      expect(timing.rateLimitWaitMs).toBeGreaterThanOrEqual(20);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries a 429-1302 on the same existing session restored to its pre-attempt snapshot", async () => {
    const { root, cwd, home, command, capture, attempts } = await prepareRateLimitFixture();
    const logs: string[] = [];
    try {
      const existingSessionFile = path.join(root, "existing-session.jsonl");
      const previousTurn = `${JSON.stringify({
        type: "turn_end",
        message: { role: "user", content: "earlier mission turn" },
      })}\n`;
      await fs.writeFile(existingSessionFile, previousTurn, "utf8");

      const result = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          rateLimitAttemptEquals: 1,
          sessionFile: existingSessionFile,
          append429Turn: true,
          logs,
          runtime: {
            sessionId: existingSessionFile,
            sessionParams: { sessionId: existingSessionFile, cwd },
            sessionDisplayId: existingSessionFile,
            taskKey: null,
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      // Attempt 1 hit 429-1302 (appending a broken error turn to the session
      // file); attempt 2 succeeded on the SAME session file.
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(2);

      // (a) The retry received the existing session file via --session.
      const captured = JSON.parse(await fs.readFile(capture, "utf8")) as {
        argv: string[];
        sessionContentAtStart: string | null;
      };
      expect(captured.argv[captured.argv.indexOf("--session") + 1]).toBe(existingSessionFile);

      // The broken 429 turn really was appended during attempt 1, so the
      // snapshot restoration below is actually exercised.
      expect(await fs.readFile(`${existingSessionFile}.429-appended`, "utf8")).toBe("1");

      // (b) The retry started from the restored pre-attempt snapshot: the
      // previous turn is preserved and the broken 429 error turn is gone.
      expect(captured.sessionContentAtStart).toBe(previousTurn);
      expect(await fs.readFile(existingSessionFile, "utf8")).toBe(previousTurn);

      // (c) The final result keeps the existing session linkage.
      expect(result.sessionId).toBe(existingSessionFile);
      expect(result.sessionParams).toEqual({ sessionId: existingSessionFile, cwd });
      expect(result.sessionDisplayId).toBe(existingSessionFile);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-run after tool calls and arms the shared cooldown for the next run", async () => {
    process.env.PAPERCLIP_PI_429_BASE_DELAY_MS = "500";
    const { root, cwd, home, command, capture, attempts } = await prepareRateLimitFixture();
    const firstLogs: string[] = [];
    try {
      const failed = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          rateLimitAfterToolCall: true,
          logs: firstLogs,
        }),
      );

      expect(failed.exitCode).toBe(1);
      expect(failed.errorMessage).toContain("1302");
      // Side effects already ran — no automatic re-execution.
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(1);
      expect(firstLogs.join("")).toContain("not re-running automatically to avoid duplicated side effects");

      const followUpLogs: string[] = [];
      const followUp = await execute(
        buildContext({ command, cwd, home, capturePath: capture, attemptPath: attempts, logs: followUpLogs }),
      );
      expect(followUp.exitCode).toBe(0);
      expect(followUpLogs.join("")).toContain("Pi rate-limit cooldown active");
      expect(timingLineOf(followUpLogs).rateLimitWaitMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the last attempt result when the retry start is blocked (Mode A)", async () => {
    const { root, cwd, home, command, capture, attempts } = await prepareRateLimitFixture();
    try {
      // Prime the models discovery cache with an identical env so the scoped
      // execute below performs no extra child spawn before its RPC attempt.
      const primed = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          rateLimitAttemptEquals: 2,
        }),
      );
      expect(primed.exitCode).toBe(0);
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(1);

      let startCount = 0;
      const scope: ChildProcessStartScope = {
        identity: { requestId: "req-1", executionId: "exec-1", attemptId: "attempt-1", executionGeneration: 0 },
        hasExternalStart: () => startCount > 0,
        start: (begin) => {
          if (startCount > 0) {
            return { kind: "additional_start_blocked", reasonCode: "runtime_shutting_down", externalStarted: true };
          }
          startCount += 1;
          return { kind: "started", value: begin(), externalStarted: true };
        },
      };
      const scopedLogs: string[] = [];
      const result = await withChildProcessStartBoundary(scope, () =>
        execute(
          buildContext({
            command,
            cwd,
            home,
            capturePath: capture,
            attemptPath: attempts,
            rateLimitAttemptEquals: 2,
            logs: scopedLogs,
          }),
        ),
      );

      // Attempt 2 failed with 429-1302; the backoff retry's start was blocked,
      // so the 429 attempt's result is preserved instead of throwing.
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("1302");
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(2);
      expect(startCount).toBe(1);
      expect(scopedLogs.join("")).toContain("rate limit 429 (code 1302) detected; backing off");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast when the shared cooldown outlives the remaining timeout budget", async () => {
    process.env.PAPERCLIP_PI_429_BASE_DELAY_MS = "400";
    const { root, cwd, home, command, capture, attempts } = await prepareRateLimitFixture();
    try {
      // 429 after tool calls arms the shared cooldown (~400ms) and returns
      // immediately without an adapter-level retry sleep.
      const failed = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          rateLimitAfterToolCall: true,
        }),
      );
      expect(failed.exitCode).toBe(1);

      const earlyLogs: string[] = [];
      const early = await execute(
        buildContext({
          command,
          cwd,
          home,
          capturePath: capture,
          attemptPath: attempts,
          timeoutSec: 0.02,
          logs: earlyLogs,
        }),
      );

      expect(early.exitCode).toBe(1);
      // R1/heartbeat-compatible code (not an unregistered pseudo-code); the
      // diagnostic identifier survives inside the message.
      expect(early.errorCode).toBe("adapter_failed");
      expect(early.errorMessage).toContain("cooldown");
      expect(early.errorMessage).toContain("[provider_rate_limited]");
      // Session linkage survives the early return.
      expect(early.sessionId).toBeTruthy();
      expect(early.sessionParams).toEqual({ sessionId: early.sessionId, cwd });
      expect(early.sessionDisplayId).toBe(early.sessionId);
      expect(early.clearSession).toBe(false);
      expect(early.billingType).toBe("unknown");
      expect(earlyLogs.join("")).toContain("failing fast instead of hitting the provider");
      // No additional pi run started for the second execute.
      expect(Number(await fs.readFile(attempts, "utf8"))).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
