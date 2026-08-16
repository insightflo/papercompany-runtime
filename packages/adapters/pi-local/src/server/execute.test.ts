import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";

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
// Real pi (rpc mode) consumes the prompt without stdin EOF; the adapter holds
// stdin open until the run settles, so read stdin asynchronously and proceed
// once the prompt chunk arrives (debounced for split writes).
let input = "";
let proceedTimer = null;
const proceed = () => {
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({
      argv,
      input,
      apiKey: process.env.PAPERCLIP_API_KEY,
      agentId: process.env.PAPERCLIP_AGENT_ID,
      runId: process.env.PAPERCLIP_RUN_ID,
      providerKey: process.env.ANTHROPIC_API_KEY,
      home: process.env.HOME,
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
  proceedTimer = setTimeout(proceed, 25);
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
  runtime?: AdapterExecutionContext["runtime"];
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
        ...(input.explicitApiKey ? { PAPERCLIP_API_KEY: input.explicitApiKey } : {}),
        ...(input.providerApiKey ? { ANTHROPIC_API_KEY: input.providerApiKey } : {}),
      },
    },
    context: {},
    authToken: input.authToken,
    onLog: async () => {},
  };
}

describe("pi_local execute contract", () => {
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
});
