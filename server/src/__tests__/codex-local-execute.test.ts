import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-codex-local/server";

// [목적] 크로스-파일 테스트 격리 누수 방지.
// 이 파일은 process.env.* 를 직접 덮어쓰지만 afterEach/afterAll 복원이 없어
// 동일 vitest worker 의 후속 테스트 파일로 변경이 새어나간다.
// 임의 쓰기(탑레벨/beforeAll/beforeEach/인라인) 위치와 무관하게 동작하도록
// 가장 이른 시점(임포트 직후, 첫 env 쓰기 이전)에 원본 값을 스냅샷한다.
const __ENV_RESTORE: Record<string, string | undefined> = {
  CODEX_HOME: process.env.CODEX_HOME,
  HOME: process.env.HOME,
  PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
  PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL,
  PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
  PAPERCLIP_IN_WORKTREE: process.env.PAPERCLIP_IN_WORKTREE,
  PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
  PAPERCLIP_LISTEN_HOST: process.env.PAPERCLIP_LISTEN_HOST,
  PAPERCLIP_LISTEN_PORT: process.env.PAPERCLIP_LISTEN_PORT,
  PAPERCLIP_TEST_CAPTURE_PATH: process.env.PAPERCLIP_TEST_CAPTURE_PATH,
  PORT: process.env.PORT,
};

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  codexHome: process.env.CODEX_HOME || null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
  paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
  paperclipApiBaseUrl: process.env.PAPERCLIP_API_BASE_URL || null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeCodexCommandWithSensitiveLogs(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const token = process.env.PAPERCLIP_API_KEY || "missing-token";

console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-sensitive" }));
console.log(JSON.stringify({
  type: "item.started",
  item: {
    id: "item_sensitive",
    type: "command_execution",
    command: '/bin/zsh -lc "curl -H \\"Authorization: Bearer ' + token + '\\" http://localhost:3100/api/issues"',
    status: "in_progress",
  },
}));
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_sensitive",
    type: "command_execution",
    command: '/bin/zsh -lc "curl -H \\"Authorization: Bearer ' + token + '\\" http://localhost:3100/api/issues"',
    aggregated_output: 'Authorization: Bearer ' + token + '\\nPAPERCLIP_API_KEY=' + token + '\\n',
    exit_code: 0,
    status: "completed",
  },
}));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  codexHome: string | null;
  paperclipEnvKeys: string[];
  paperclipApiUrl?: string | null;
  paperclipApiBaseUrl?: string | null;
};

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

describe("codex execute", () => {
  // [목적] 스냅샷된 원본 env 값을 파일 종료 시 복원하여 후속 테스트 파일로의 누수 차단.
  // 원본이 undefined 였으면 키를 삭제, 그렇지 않으면 원래 값으로 되돌린다.
  afterAll(() => {
    for (const [k, v] of Object.entries(__ENV_RESTORE)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses a Paperclip-managed CODEX_HOME outside worktree mode while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-default-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-default",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);

      const managedAuth = path.join(managedCodexHome, "auth.json");
      const managedConfig = path.join(managedCodexHome, "config.toml");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(managedConfig)).isFile()).toBe(true);
      expect(await fs.readFile(managedConfig, "utf8")).toBe('model = "codex-mini-latest"\n');
      await expect(fs.lstat(path.join(sharedCodexHome, "companies", "company-1"))).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using Paperclip-managed Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes the control-plane URL from context into the Codex child environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-api-url-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    const previousPaperclipListenHost = process.env.PAPERCLIP_LISTEN_HOST;
    const previousPaperclipListenPort = process.env.PAPERCLIP_LISTEN_PORT;
    const previousPort = process.env.PORT;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_LISTEN_PORT;
    delete process.env.PORT;

    try {
      const result = await execute({
        runId: "run-api-url",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
        },
        context: {
          paperclipApiUrl: "http://127.0.0.1:3100",
          paperclipApiBaseUrl: "http://127.0.0.1:3100/api",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipApiUrl).toBe("http://127.0.0.1:3100");
      expect(capture.paperclipApiBaseUrl).toBe("http://127.0.0.1:3100/api");
    } finally {
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
      if (previousPaperclipListenHost === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
      else process.env.PAPERCLIP_LISTEN_HOST = previousPaperclipListenHost;
      if (previousPaperclipListenPort === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
      else process.env.PAPERCLIP_LISTEN_PORT = previousPaperclipListenPort;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a worktree-isolated CODEX_HOME while preserving shared auth and config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const isolatedCodexHome = path.join(
      paperclipHome,
      "instances",
      "worktree-1",
      "companies",
      "company-1",
      "codex-home",
    );
    const workspaceSkill = path.join(workspace, ".agents", "skills", "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(isolatedCodexHome);
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );

      const isolatedAuth = path.join(isolatedCodexHome, "auth.json");
      const isolatedConfig = path.join(isolatedCodexHome, "config.toml");

      expect((await fs.lstat(isolatedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(isolatedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      expect((await fs.lstat(isolatedConfig)).isFile()).toBe(true);
      expect(await fs.readFile(isolatedConfig, "utf8")).toBe('model = "codex-mini-latest"\n');
      expect((await fs.lstat(workspaceSkill)).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using worktree-isolated Codex home"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Injected Codex skill "paperclip"'),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an early session update when Codex reports thread.started", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-session-update-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    try {
      const sessionUpdates: unknown[] = [];
      const result = await execute({
        runId: "run-session-update",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        onLog: async () => {},
        onSessionUpdate: async (update) => {
          sessionUpdates.push(update);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(sessionUpdates).toEqual([
        expect.objectContaining({
          sessionId: "codex-session-1",
          sessionDisplayId: "codex-session-1",
          source: "stdout",
          confidence: "provider_reported",
          sessionParams: expect.objectContaining({
            sessionId: "codex-session-1",
            cwd: workspace,
          }),
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects the shared runtime brief instead of raw handoff markdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-runtime-brief-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-runtime-brief",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
        },
        context: {
          paperclipStepInputManifest: {
            version: 1,
            taskKey: "issue:123",
            issueId: "issue-1",
            projectId: null,
            allowedContextKeys: ["issueId", "paperclipWorkspace"],
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
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("Paperclip runtime brief:");
      expect(capture.prompt).toContain("Task key: issue:123");
      expect(capture.prompt).toContain("Previous session: sess-1");
      expect(capture.prompt).not.toContain("# raw handoff markdown should not appear");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects an explicit CODEX_HOME config override even in worktree mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-explicit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const explicitCodexHome = path.join(root, "explicit-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
            CODEX_HOME: explicitCodexHome,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(explicitCodexHome);
      expect((await fs.lstat(path.join(workspace, ".agents", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
      await expect(fs.lstat(path.join(paperclipHome, "instances", "worktree-1", "codex-home"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("redacts PAPERCLIP_API_KEY-bearing command logs before persisting stdout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-redaction-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommandWithSensitiveLogs(commandPath);

    try {
      const logs: LogEntry[] = [];
      const token = "run-jwt-token-sensitive";
      const result = await execute({
        runId: "run-redaction",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
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
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: token,
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.resultJson?.stdout).toContain("***REDACTED***");
      expect(result.resultJson?.stdout).not.toContain(token);

      const combinedStdout = logs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.chunk)
        .join("");
      expect(combinedStdout).toContain("***REDACTED***");
      expect(combinedStdout).not.toContain(token);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
