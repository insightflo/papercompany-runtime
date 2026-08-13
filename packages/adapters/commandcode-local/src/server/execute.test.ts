import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";
import {
  buildCtx,
  resultFrame,
  writeFakeCmd,
  type CapturePayload,
} from "./execute-fixtures.js";

describe("commandcode execute", () => {
  it("constructs the headless command with json output and automation flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-construct-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, { lines: [resultFrame({ subtype: "success", finalText: "done", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })] });
    try {
      const result = await execute(buildCtx({ model: "moonshotai/kimi-k2.5", effort: "high" }, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.errorMessage).toBeNull();
      const argv = (JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload).argv.join(" ");
      expect(argv).toContain("--output-format json");
      expect(argv).toContain("--skip-onboarding");
      expect(argv).toContain("--permission-mode auto-accept");
      expect(argv).toContain("--trust");
      expect(argv).toContain("--no-auto-update");
      expect(argv).toContain("--model moonshotai/kimi-k2.5");
      expect(argv).toContain("--effort high");
      expect(argv).toContain("-p");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors a command override through adapter config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-override-"));
    const workspace = path.join(root, "workspace");
    const customBin = path.join(root, "mycmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(customBin, { lines: [resultFrame({ subtype: "success", finalText: "ok", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })] });
    try {
      const result = await execute(buildCtx({ command: customBin }, { command: "/__should_not_run__", cwd: workspace, capture: capturePath }));
      expect(result.errorMessage).toBeNull();
      expect(JSON.parse(await fs.readFile(capturePath, "utf8"))).toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("launches with --yolo and omits --permission-mode when dangerouslySkipPermissions is true", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-yolo-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, { lines: [resultFrame({ subtype: "success", finalText: "done", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })] });
    try {
      await execute(buildCtx({ dangerouslySkipPermissions: true }, { command: commandPath, cwd: workspace, capture: capturePath }));
      const argv = (JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload).argv;
      expect(argv).toContain("--yolo");
      expect(argv).not.toContain("--permission-mode");
      expect(argv.filter((a) => a === "--permission-mode").length).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the safe --permission-mode auto-accept default and never adds --yolo when absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-safedefault-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, { lines: [resultFrame({ subtype: "success", finalText: "done", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })] });
    try {
      await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      const argv = (JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload).argv;
      expect(argv).toContain("--permission-mode");
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto-accept");
      expect(argv).not.toContain("--yolo");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies stopReason permission_denied as a failure even with subtype success and exit 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-permdenied-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, {
      lines: [resultFrame({ subtype: "success", stopReason: "permission_denied", finalText: "", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })],
      exitCode: 0,
    });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("commandcode_permission_denied");
      expect(result.errorMessage).toBeTruthy();
      expect(result.errorMessage).toContain("permission");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("parses a success result into summary, usage, and session id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-success-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, {
      lines: [
        resultFrame({ subtype: "success", sessionId: "cmd-sess-42", usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 3 }, durationMs: 9, finalText: "hello there" }),
      ],
    });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.summary).toBe("hello there");
      expect(result.usage?.inputTokens).toBe(12);
      expect(result.usage?.outputTokens).toBe(8);
      expect(result.usage?.cachedInputTokens).toBe(3);
      expect(result.costUsd).toBeNull();
      expect(result.sessionId).toBe("cmd-sess-42");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails on result subtype error even when the OS exit code is 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-error0-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, {
      lines: [resultFrame({ subtype: "error", finalText: "", usage: { inputTokens: 1, outputTokens: 0 }, durationMs: 1, error: "not authenticated" })],
      exitCode: 0,
    });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBeTruthy();
      expect(result.errorMessage).toContain("not authenticated");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails when a success result is followed by a nonzero process exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-success-nonzero-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, {
      lines: [resultFrame({ subtype: "success", finalText: "premature", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })],
      exitCode: 2,
    });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(2);
      expect(result.errorMessage).toContain("exited abnormally");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("represents max_turns accurately (errorCode + partial summary)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-maxturns-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, {
      lines: [resultFrame({ subtype: "max_turns", sessionId: "s", usage: { inputTokens: 5, outputTokens: 5 }, durationMs: 1, finalText: "partial answer" })],
      exitCode: 8,
    });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(8);
      expect(result.errorCode).toBe("commandcode_max_turns");
      expect(result.summary).toBe("partial answer");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the process exits 0 with no result line", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-noresult-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    // Only event frames, no result line, exit 0.
    await writeFakeCmd(commandPath, { lines: [JSON.stringify({ type: "event", event: { type: "text_delta", delta: "stray" } })], exitCode: 0 });
    try {
      const result = await execute(buildCtx({}, { command: commandPath, cwd: workspace, capture: capturePath }));
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBeTruthy();
      expect(result.errorCode).toBe("commandcode_missing_result");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drops reserved flags from extraArgs so they cannot override enforced args", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-reserved-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCmd(commandPath, { lines: [resultFrame({ subtype: "success", finalText: "ok", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })] });
    try {
      await execute(
        buildCtx({ extraArgs: ["--verbose", "--model", "evil", "--output-format=text", "--yolo", "--max-turns", "1", "--", "--safe-flag"] }, {
          command: commandPath,
          cwd: workspace,
          capture: capturePath,
        }),
      );
      const argv = (JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload).argv;
      const argvStr = argv.join(" ");
      expect(argvStr).toContain("--safe-flag");
      expect(argvStr).not.toContain("evil");
      expect(argvStr).not.toContain("--output-format=text");
      expect(argvStr).not.toContain("--yolo");
      expect(argv).not.toContain("--");
      // enforced --output-format json still present exactly once
      expect(argv.filter((a) => a === "--output-format").length).toBe(1);
      expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a fresh sessionId after a stale-session retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-exec-stale-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    // The resume call (--resume <id>) errors as an unknown session; a fresh call
    // (no --resume) succeeds and returns a new session id.
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.ADAPTER_TEST_CAPTURE_PATH, JSON.stringify({ argv }, null, 2), 'utf8');
const resumeIdx = argv.indexOf('--resume');
if (resumeIdx !== -1) {
  console.error('Error: unknown session id ' + argv[resumeIdx + 1]);
  process.exit(1);
}
console.log(${JSON.stringify(resultFrame({ subtype: "success", sessionId: "fresh-9", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, finalText: "continued" }))});
process.exit(0);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);
    try {
      const result = await execute(
        buildCtx(
          { env: { ADAPTER_TEST_CAPTURE_PATH: capturePath } },
          { command: commandPath, cwd: workspace, capture: capturePath, runtime: { sessionParams: { sessionId: "stale-1", cwd: workspace } } },
        ),
      );
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("fresh-9");
      expect(result.clearSession).toBe(false);
      expect(result.summary).toBe("continued");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
