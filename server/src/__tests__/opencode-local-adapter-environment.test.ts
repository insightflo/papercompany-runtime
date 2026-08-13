import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-opencode-local/server";

// Snapshot original values BEFORE any test mutates them so we can restore a
// pristine environment for subsequent test files in the same vitest worker.
const __ENV_RESTORE: Record<string, string | undefined> = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

afterAll(() => {
  for (const [k, v] of Object.entries(__ENV_RESTORE)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

async function writeFakeOpenCodeCommand(binDir: string, envCapturePath: string): Promise<string> {
  const commandPath = path.join(binDir, "opencode");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const envPath = process.env.ADAPTER_TEST_ENV_PATH;
if (envPath) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(envPath, "utf8")); } catch {}
  entries.push({
    phase: process.argv[2] ?? "unknown",
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });
  fs.writeFileSync(envPath, JSON.stringify(entries), "utf8");
}
if (process.argv[2] === "models") {
  console.log("openai/test-model");
} else {
  console.log(JSON.stringify({ type: "text", part: { text: "hello" } }));
}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("opencode_local environment diagnostics", () => {
  it("reports a missing working directory as an error when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-opencode-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "opencode_cwd_invalid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("treats an empty OPENAI_API_KEY override as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-empty-key-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-value";

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
          env: {
            OPENAI_API_KEY: "",
          },
        },
      });

      const missingCheck = result.checks.find((check) => check.code === "opencode_openai_api_key_missing");
      expect(missingCheck).toBeTruthy();
      expect(missingCheck?.hint).toContain("empty");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("sanitizes Paperclip runtime variables for model discovery and hello probe children", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-child-"));
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const envCapturePath = path.join(root, "env.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    const command = await writeFakeOpenCodeCommand(binDir, envCapturePath);
    const originalRunId = process.env.PAPERCLIP_RUN_ID;
    process.env.PAPERCLIP_RUN_ID = "inherited-run";

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command,
          cwd,
          model: "openai/test-model",
          env: {
            OPENAI_API_KEY: "test-key",
            PAPERCLIP_AGENT_ID: "configured-agent",
            PAPERCLIP_API_KEY: "configured-token",
            PAPERCLIP_RUN_ID: "configured-run",
            ADAPTER_TEST_ENV_PATH: envCapturePath,
          },
        },
      });

      expect(result.status).toBe("pass");
      const children = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Array<Record<string, string | undefined>>;
      expect(children.length).toBeGreaterThanOrEqual(2);
      for (const childEnv of children) {
        expect(childEnv.PAPERCLIP_AGENT_ID).toBeUndefined();
        expect(childEnv.PAPERCLIP_API_KEY).toBeUndefined();
        expect(childEnv.PAPERCLIP_RUN_ID).toBeUndefined();
        expect(childEnv.OPENAI_API_KEY).toBe("test-key");
      }
    } finally {
      if (originalRunId === undefined) delete process.env.PAPERCLIP_RUN_ID;
      else process.env.PAPERCLIP_RUN_ID = originalRunId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies ProviderModelNotFoundError probe output as model-unavailable warning", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-bin-"));
    const fakeOpencode = path.join(binDir, "opencode");
    const script = [
      "#!/bin/sh",
      "echo 'ProviderModelNotFoundError: ProviderModelNotFoundError' 1>&2",
      "echo 'data: { providerID: \"openai\", modelID: \"gpt-5.3-codex\", suggestions: [] }' 1>&2",
      "exit 1",
      "",
    ].join("\n");

    try {
      await fs.writeFile(fakeOpencode, script, "utf8");
      await fs.chmod(fakeOpencode, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
        },
      });

      const modelCheck = result.checks.find((check) => check.code === "opencode_hello_probe_model_unavailable");
      expect(modelCheck).toBeTruthy();
      expect(modelCheck?.level).toBe("warn");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});
