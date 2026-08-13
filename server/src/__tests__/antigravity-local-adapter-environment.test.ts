import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-antigravity-local/server";

async function writeFakeAntigravityCommand(binDir: string): Promise<string> {
  const commandPath = path.join(binDir, "agy");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.ADAPTER_TEST_ENV_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  }), "utf8");
}
console.log("AGY_OK");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("antigravity_local child environment", () => {
  it("keeps generated runtime values and auth while removing configured Paperclip overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-env-"));
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const envCapturePath = path.join(root, "env.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    const command = await writeFakeAntigravityCommand(binDir);
    const originalRunId = process.env.PAPERCLIP_RUN_ID;
    process.env.PAPERCLIP_RUN_ID = "inherited-run";

    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command,
          cwd,
          env: {
            GOOGLE_API_KEY: "provider-key",
            PAPERCLIP_AGENT_ID: "configured-agent",
            PAPERCLIP_API_KEY: "configured-token",
            PAPERCLIP_RUN_ID: "configured-run",
            ADAPTER_TEST_ENV_PATH: envCapturePath,
          },
        },
        context: {},
        authToken: "auth-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Record<string, string | undefined>;
      expect(childEnv.PAPERCLIP_AGENT_ID).toBe("agent-1");
      expect(childEnv.PAPERCLIP_API_KEY).toBe("auth-token");
      expect(childEnv.PAPERCLIP_RUN_ID).toBe("run-1");
      expect(childEnv.GOOGLE_API_KEY).toBe("provider-key");
    } finally {
      if (originalRunId === undefined) delete process.env.PAPERCLIP_RUN_ID;
      else process.env.PAPERCLIP_RUN_ID = originalRunId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
