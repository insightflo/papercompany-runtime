import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executeHermesLocal } from "../adapters/hermes-local-execute.js";

function buildContext(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-hermes-1",
    agent: {
      id: "agent-hermes-1",
      companyId: "company-hermes-1",
      name: "Hermes Agent",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    authToken: "jwt-auth-token",
    onLog: async () => {},
  };
}

describe("hermes_local execution environment", () => {
  it("removes inherited/configured Paperclip overrides while preserving runtime identity and auth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-env-"));
    const commandPath = path.join(root, "hermes");
    const cwd = path.join(root, "workspace");
    const envCapturePath = path.join(root, "env.json");
    await mkdir(cwd);
    await writeFile(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ADAPTER_TEST_ENV_PATH, JSON.stringify({
  PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
  PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
  PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID,
  PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
  ADAPTER_TEST_ENV_PATH: process.env.ADAPTER_TEST_ENV_PATH,
}), "utf8");
process.stdout.write("Hermes response\\nsession_id: hermes-session-1\\n");
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    const originalAgentId = process.env.PAPERCLIP_AGENT_ID;
    process.env.PAPERCLIP_AGENT_ID = "inherited-agent";
    try {
      const result = await executeHermesLocal(
        buildContext({
          command: commandPath,
          cwd,
          env: {
            PAPERCLIP_AGENT_ID: "configured-agent",
            PAPERCLIP_RUN_ID: "configured-run",
            PAPERCLIP_API_KEY: "configured-token",
            ADAPTER_TEST_ENV_PATH: envCapturePath,
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(await readFile(envCapturePath, "utf8")) as Record<string, string>;
      expect(childEnv.PAPERCLIP_AGENT_ID).toBe("agent-hermes-1");
      expect(childEnv.PAPERCLIP_COMPANY_ID).toBe("company-hermes-1");
      expect(childEnv.PAPERCLIP_RUN_ID).toBe("run-hermes-1");
      expect(childEnv.PAPERCLIP_API_KEY).toBe("jwt-auth-token");
      expect(childEnv.ADAPTER_TEST_ENV_PATH).toBe(envCapturePath);
    } finally {
      if (originalAgentId === undefined) delete process.env.PAPERCLIP_AGENT_ID;
      else process.env.PAPERCLIP_AGENT_ID = originalAgentId;
      await rm(root, { recursive: true, force: true });
    }
  });
});
