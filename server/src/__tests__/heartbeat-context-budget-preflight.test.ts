import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySecrets,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
  knowledgeBases,
  issueComments,
  issues,
  missions,
  missionSessions,
  projects,
  toolDefinitions,
  agentKbGrants,
  agentTaskSessions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workspaceRuntimeServices,
} from "@paperclipai/db";

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-budget-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function cleanupHeartbeatRunRecords(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("heartbeat context budget preflight", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    executeSpy.mockReset();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db.delete(agentTaskSessions);
    await cleanupHeartbeatRunRecords(db);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issueComments);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(toolDefinitions);
    await db.delete(agentKbGrants);
    await db.delete(knowledgeBases);
    await db.delete(missionSessions);
    await db.delete(missions);
    await db.delete(companySecrets);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("blocks execution before adapter.execute when the estimated context budget is exceeded", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budgeted Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "x".repeat(400),
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 5,
          },
        },
      },
      permissions: {},
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [{ serviceName: "api", url: "http://localhost:4100", scopeType: "run", lifecycle: "ephemeral" }],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { note: "y".repeat(100) }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(finalized.error).toContain("exceeds budget");
    expect(finalized.wakeupRequestId).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, finalized.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("failed");
  });

  it("blocks explicit broad-scan prompts when the manifest forbids them", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:broad-scan";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_blocked");
    expect(finalized.error).toContain("scan the entire repo");
  });

  it("blocks a live broad-scan tool call before adapter execution can continue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog("stdout", `${JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "find . -type f",
          status: "in_progress",
        },
      })}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("blocks a chunk-split live tool call after the full JSON line is reconstructed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-split";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "gemini_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shell: {
          command: "find . -type f",
        },
      },
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      const midpoint = Math.floor(line.length / 2);
      await onLog("stdout", line.slice(0, midpoint));
      await onLog("stdout", `${line.slice(midpoint)}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("blocks a cursor shell tool call when normalized JSONL arrives on stderr", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-cursor-stderr";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog(
        "stderr",
        `${JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_1",
          tool_call: {
            shellToolCall: {
              command: "find . -type f",
            },
          },
        })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("still blocks bootstrap broad-scan prompts when a saved session exists but cwd mismatch prevents resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:broad-scan-mismatch";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
        bootstrapPromptTemplate: "Please scan the entire repo before doing anything else.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "sess-1", cwd: "/tmp/other-cwd" },
      sessionDisplayId: "sess-1",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_blocked");
    expect(finalized.error).toContain("scan the entire repo");
  });

  it("counts agent and run placeholders before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent Name That Expands Budget",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "{{agent.name}} {{runId}} {{agent.name}} {{runId}}",
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedChars: 20,
          },
        },
      },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(finalized.error).toContain("chars exceeds budget");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("attaches a server-computed step input manifest before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:manifest";
    const runtimeServiceId = randomUUID();
    const issueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Manifest issue",
      status: "todo",
    });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts and ../secret.env",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [{
          id: runtimeServiceId,
          scopeType: "run",
          scopeId: "run-scope",
          serviceName: "api",
          status: "running",
          lifecycle: "ephemeral",
          port: 4100,
          url: "http://localhost:4100",
          healthStatus: "healthy",
        }],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId, note: "hello" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const executionContext = executeSpy.mock.calls[0]?.[0] as { runtime: { taskKey: string | null } };
    expect(executionContext.runtime.taskKey).toBe(taskKey);
    expect(invocationContext).toBeDefined();
    if (!invocationContext) {
      throw new Error("Expected adapter invocation context to be captured");
    }
    const adapterVisibleContext = invocationContext;
    expect(adapterVisibleContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        version: 1,
        taskKey,
        issueId,
        allowedContextKeys: Object.keys(adapterVisibleContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        guardrails: { broadScanAllowed: false },
        inputs: expect.objectContaining({
          workspace: {
            available: true,
            source: "agent_home",
            workspaceId: null,
            projectId: null,
          },
          workspaceHints: { available: false, count: 0 },
          runtimeServiceIntents: { available: false, count: 0 },
          runtimeServices: { available: false, count: 0, primaryUrl: null },
          fileViews: { available: true, count: 1, source: "wake_comment" },
          sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
        }),
      }),
    );
    expect(adapterVisibleContext.paperclipFileViews).toEqual([
      {
        workspaceId: null,
        relativePath: "src/server.ts",
        source: "wake_comment",
        exists: false,
      },
    ]);
    const persistedContext = finalized.contextSnapshot ?? {};
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(persistedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        inputs: expect.objectContaining({
          runtimeServices: {
            available: true,
            count: 1,
            primaryUrl: "http://localhost:4100",
          },
          fileViews: {
            available: true,
            count: 1,
            source: "wake_comment",
          },
        }),
      }),
    );
  });

  it("attaches workflow step tool contracts to the runtime context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const toolId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow tool contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workflow step issue",
      status: "todo",
    });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "search-docs",
      description: "Search project documentation",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          toolNames: ["search-docs"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepToolContract).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      toolNames: ["search-docs"],
      tools: [
        {
          name: "search-docs",
          description: "Search project documentation",
          adapterType: "builtin",
        },
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          tools: {
            available: true,
            count: 1,
            names: ["search-docs"],
          },
        }),
      }),
    );
    const persistedComments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(persistedComments).toHaveLength(0);
  });

  it("fails before adapter execution when a workflow step references missing tools", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow tool contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workflow step issue",
      status: "todo",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          toolNames: ["missing-tool"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("workflow_step_tool_contract_invalid");
    expect(finalized.error).toContain("missing tools: missing-tool");
  });

  it("attaches workflow step knowledge contracts to the runtime context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review production deployment policy",
      description: "We need the latest deployment checklist for production changes.",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Deployment KB",
      type: "rag",
      description: "Deployment procedures",
      maxTokenBudget: 1024,
      configJson: {
        documents: [
          {
            id: "doc-1",
            title: "Production Deployment Checklist",
            content: "Production changes require a checklist, approvals, rollback notes, and smoke tests.",
          },
        ],
      },
    });
    await db.insert(agentKbGrants).values({
      id: randomUUID(),
      agentId,
      kbId: knowledgeBaseId,
      grantedBy: "board-user",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { issueId, note: "Need the production checklist." },
      "manual",
      {
        actorType: "system",
        actorId: "test-suite",
      },
    );

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepKnowledgeContext).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      knowledgeBaseIds: [knowledgeBaseId],
      entries: [
        expect.objectContaining({
          id: knowledgeBaseId,
          name: "Deployment KB",
          type: "rag",
          source: "Deployment KB",
          content: expect.stringContaining("Production Deployment Checklist"),
        }),
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          knowledge: {
            available: true,
            count: 1,
            names: ["Deployment KB"],
          },
        }),
      }),
    );
    const persistedComments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(persistedComments).toHaveLength(0);
  });

  it("fails before adapter execution when a workflow step references inaccessible knowledge bases", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review deployment policy",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Restricted KB",
      type: "static",
      description: "Restricted knowledge",
      maxTokenBudget: 1024,
      configJson: {
        content: "Restricted deployment policy",
      },
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("workflow_step_kb_contract_invalid");
    expect(finalized.error).toContain("missing or inaccessible KBs");
  });

  it("does not attach file views when wakeCommentId belongs to a different issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:file-view-mismatch";
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Target issue",
        status: "todo",
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
      },
    ]);
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId: otherIssueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts",
    });

    executeSpy.mockImplementationOnce(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          fileViews: {
            available: false,
            count: 0,
            source: null,
          },
        }),
      }),
    );
  });

  it("persists executionWorkspaceId in the manifest before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workspace",
      issuePrefix: "PWX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Project",
      status: "backlog",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Workspace issue",
      status: "todo",
    });

    const heartbeat = heartbeatService(db);
    executeSpy.mockImplementation(async ({ runId, context }) => {
      const persisted = await heartbeat.getRun(runId);
      expect(persisted?.issueId).toBe(issueId);
      const persistedContext = persisted?.contextSnapshot ?? {};
      expect(persistedContext.executionWorkspaceId).toBeTruthy();
      expect(persistedContext.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
      expect(context.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
  });

  it("refreshes the manifest after a same-task wake is coalesced into a running run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:coalesced";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coalesced Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {
        taskKey,
        paperclipStepInputManifest: {
          version: 1,
          taskKey,
          issueId: null,
          projectId: null,
          allowedContextKeys: ["taskKey"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: false, source: null, workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.invoke(agentId, "on_demand", { taskKey, note: "coalesced note" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(mergedRun).not.toBeNull();
    expect(mergedRun?.id).toBe(existingRunId);
    expect(executeSpy).not.toHaveBeenCalled();
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["note", "taskKey", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("refreshes the manifest for issue-execution same-agent coalesced wakes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Execution Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId,
        paperclipStepInputManifest: {
          version: 1,
          taskKey: issueId,
          issueId,
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: false, source: null, workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "todo",
      executionRunId: existingRunId,
      executionAgentNameKey: "execution agent",
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "issue-exec note" },
    });

    expect(mergedRun?.id).toBe(existingRunId);
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("refreshes the manifest inside deferred issue-execution wake payloads", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runningRunId = randomUUID();
    const deferredId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deferred Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred issue",
      status: "todo",
      executionRunId: runningRunId,
      executionAgentNameKey: "someone-else",
      executionLockedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          paperclipStepInputManifest: {
            version: 1,
            taskKey: issueId,
            issueId,
            projectId: null,
            allowedContextKeys: ["issueId"],
            guardrails: { broadScanAllowed: false },
            inputs: {
              workspace: { available: false, source: null, workspaceId: null, projectId: null },
              workspaceHints: { available: false, count: 0 },
              runtimeServiceIntents: { available: false, count: 0 },
              runtimeServices: { available: false, count: 0, primaryUrl: null },
              sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
            },
          },
        },
      },
      status: "deferred_issue_execution",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "deferred note" },
    });

    expect(result).toBeNull();
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredId))
      .then((rows) => rows[0] ?? null);
    expect(deferred).not.toBeNull();
    expect(deferred?.coalescedCount).toBe(1);
    const deferredContext = (deferred?.payload as Record<string, unknown>)._paperclipWakeContext as Record<string, unknown>;
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(deferredContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("attaches a structured session handoff artifact alongside markdown when compaction rotates the session", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:handoff";
    const previousRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Handoff",
      issuePrefix: "PHO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Handoff Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Continue the assigned work.",
      },
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxRawInputTokens: 1,
          },
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      contextSnapshot: { taskKey },
      sessionIdAfter: "sess-1",
      usageJson: { rawInputTokens: 100 },
      resultJson: { summary: "Last run summarized the issue state" },
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      createdAt: new Date("2026-04-10T00:05:00.000Z"),
      updatedAt: new Date("2026-04-10T00:05:00.000Z"),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "sess-1", cwd: process.cwd() },
      sessionDisplayId: "sess-1",
      lastRunId: previousRunId,
    });

    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipSessionHandoffMarkdown).toContain("Previous session: sess-1");
    expect(invocationContext?.paperclipSessionHandoff).toEqual({
      version: 1,
      previousSessionId: "sess-1",
      previousRunId,
      issueId: null,
      rotationReason: "session raw input reached 100 tokens (threshold 1)",
      lastRunSummaryText: "Last run summarized the issue state",
    });
    expect(finalized.contextSnapshot?.paperclipSessionHandoff).toEqual(invocationContext?.paperclipSessionHandoff);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            sessionCompaction: {
              enabled: true,
              maxRawInputTokens: 0,
            },
          },
        },
      })
      .where(eq(agents.id, agentId));

    let secondInvocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementationOnce(async ({ context }) => {
      secondInvocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const secondRun = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(secondRun).not.toBeNull();
    const secondFinalized = await waitForRunTerminal(heartbeat, secondRun!.id);
    expect(secondFinalized.status).toBe("succeeded");
    expect(secondInvocationContext?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondInvocationContext?.paperclipSessionHandoff).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoff).toBeUndefined();
  });

  it("preserves scheduler mission context and reuses the mission-scoped session path before execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Scheduler",
      issuePrefix: `PSC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduled Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Scheduled mission",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: `mission:${missionId}`,
      sessionParamsJson: { sessionId: "mission-session-1" },
      sessionDisplayId: "mission-session-1",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "scheduler",
      triggerDetail: "schedule:daily-sync",
      payload: { missionId },
      reason: "scheduled_wakeup",
    });

    expect(run).not.toBeNull();
    expect(run?.invocationSource).toBe("scheduler");
    expect(run?.sessionIdBefore).toBe("mission-session-1");
    expect(run?.contextSnapshot).toEqual(
      expect.objectContaining({
        missionId,
        wakeSource: "scheduler",
        wakeTriggerDetail: "schedule:daily-sync",
      }),
    );
  });

  it("creates a mission-session binding from an existing mission task session on wakeup", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission Session",
      issuePrefix: `PMS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Mission binding",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: `mission:${missionId}`,
      sessionParamsJson: { sessionId: "legacy-mission-session" },
      sessionDisplayId: "legacy-mission-session",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "scheduler",
      triggerDetail: "schedule:mission-session",
      payload: { missionId },
      reason: "scheduled_wakeup",
    });

    expect(run?.sessionIdBefore).toBe("legacy-mission-session");

    const [session] = await db
      .select()
      .from(missionSessions)
      .where(eq(missionSessions.missionId, missionId))
      .limit(1);
    expect(session).toBeTruthy();
    expect(session?.agentId).toBe(agentId);

    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, session!.sessionSecretId))
      .limit(1);
    expect(secret?.name).toContain(`mission-session:${missionId}:${agentId}:codex_local`);

    const resolved = await secretService(db).resolveSecretValue(companyId, session!.sessionSecretId, "latest");
    expect(resolved).toBe("legacy-mission-session");
  });

  it("persists an early adapter session update on the heartbeat run before final result canonicalization", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Early Session",
      issuePrefix: `PES${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Early Session Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onSessionUpdate }) => {
      await onSessionUpdate?.({
        sessionId: "early-session-1",
        sessionParams: { sessionId: "early-session-1", cwd: "/tmp/workspace" },
        sessionDisplayId: "early-session-1",
        source: "stdout",
        confidence: "provider_reported",
        observedAt: "2026-04-25T15:00:00.000Z",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(finalized.sessionIdAfter).toBe("early-session-1");
  });

  it("persists the latest adapter session id back into the mission-session binding", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    let runtimeSessionIdSeen: string | null = null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission Session",
      issuePrefix: `PMR${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Mission rotation",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);

    const secret = await secretService(db).create(companyId, {
      name: `mission-session:${missionId}:${agentId}:codex_local`,
      provider: "local_encrypted",
      value: "mission-session-old",
      description: "test mission session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId,
      companyId,
      sessionSecretId: secret.id,
      adapterType: "codex_local",
    });

    executeSpy.mockImplementationOnce(async ({ runtime }) => {
      runtimeSessionIdSeen = runtime.sessionId ?? null;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        sessionId: "mission-session-new",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { missionId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(runtimeSessionIdSeen).toBe("mission-session-old");

    const [session] = await db
      .select()
      .from(missionSessions)
      .where(eq(missionSessions.missionId, missionId))
      .limit(1);
    const resolved = await secretService(db).resolveSecretValue(companyId, session!.sessionSecretId, "latest");
    expect(resolved).toBe("mission-session-new");
  });

  it("reports mission-session authority in runtime state when an active mission binding exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionSessionId = "mission-session-visible";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission State",
      issuePrefix: `PMS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission State Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "runtime-fallback-session",
      stateJson: {},
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "manual:legacy",
      sessionParamsJson: { sessionId: "legacy-task-session" },
      sessionDisplayId: "legacy-task-session",
    });

    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Mission state surface",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);

    const secret = await secretService(db).create(companyId, {
      name: `mission-session:${missionId}:${agentId}:codex_local`,
      provider: "local_encrypted",
      value: missionSessionId,
      description: "test runtime state mission session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId,
      companyId,
      sessionSecretId: secret.id,
      adapterType: "codex_local",
      runCount: 3,
    });

    const state = await heartbeatService(db).getRuntimeState(agentId);

    expect(state).toBeTruthy();
    expect(state?.sessionAuthority).toBe("mission_session");
    expect(state?.sessionDisplayId).toBe(missionSessionId);
    expect(state?.sessionParamsJson).toBeNull();
    expect(state?.activeMissionSessionCount).toBe(1);
    expect(state?.latestMissionSession).toEqual(
      expect.objectContaining({
        missionId,
        sessionId: missionSessionId,
        runCount: 3,
      }),
    );
  });
});
