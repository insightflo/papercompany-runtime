import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

async function writeFakeCmd(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("deepseek/deepseek-v4-pro  DeepSeek V4 Pro");
  process.exit(0);
}
const mode = process.env.COMMANDCODE_TEST_MODE;
if (mode === "missing_result") {
  console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "hello" } }));
  process.exit(0);
}
if (mode === "empty_error") {
  console.log(JSON.stringify({
    type: "result",
    subtype: "error",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    finalText: "hello",
    error: "",
  }));
  process.exit(0);
}
process.exit(2);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runProbe(mode: "missing_result" | "empty_error") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `commandcode-env-${mode}-`));
  const cwd = path.join(root, "workspace");
  const command = path.join(root, "cmd");
  await fs.mkdir(cwd, { recursive: true });
  await writeFakeCmd(command);
  try {
    return await testEnvironment({
      companyId: "company-1",
      adapterType: "commandcode_local",
      config: {
        command,
        cwd,
        model: "deepseek/deepseek-v4-pro",
        env: { COMMANDCODE_TEST_MODE: mode },
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("commandcode_local environment diagnostics", () => {
  it("fails closed when hello text arrives without the final result frame", async () => {
    const result = await runProbe("missing_result");
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "commandcode_hello_probe_passed")).toBe(false);
    expect(result.checks.some((check) => check.code === "commandcode_hello_probe_failed")).toBe(true);
  });

  it("fails when the final result subtype is error even with empty error text", async () => {
    const result = await runProbe("empty_error");
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "commandcode_hello_probe_passed")).toBe(false);
    expect(result.checks.some((check) => check.code === "commandcode_hello_probe_failed")).toBe(true);
  });
});
