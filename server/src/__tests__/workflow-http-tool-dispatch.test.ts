import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  missions,
  toolDefinitions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ADAPTER_CONFIG = {
  url: "https://n8n.example.test/webhook/daily-tech-scout",
  method: "POST",
  timeoutMs: 120_000,
  auth: {
    type: "header",
    headerName: "X-Papercompany-Webhook-Key",
    secretId: "secret-1",
    version: "latest",
  },
  response: {
    resultField: "result",
    artifactField: "artifact",
    artifactFileName: "raw-tech-scout.json",
    artifactPathResultField: "rawPath",
  },
};

const RESULT = {
  ok: true,
  date: "2026-07-14",
  source: "https://trendshift.io/",
  collected_at: "2026-07-14T05:00:00.000Z",
  count: 1,
  repos: [{ rank: 1, full_name: "owner/repo", readme_excerpt: "short" }],
  nextAction: "Use rawPath for the report evidence.",
};

const ARTIFACT = {
  ok: true,
  date: "2026-07-14",
  source: "https://trendshift.io/",
  collected_at: "2026-07-14T05:00:00.000Z",
  count: 1,
  repos: [{ rank: 1, full_name: "owner/repo", readme_excerpt: "full readme" }],
};

const SECRET_VALUE = "test-webhook-secret";

function makeFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

type FetchLike = typeof fetch;

function makeStepDir(): string {
  return mkdtempSync(join(tmpdir(), "http-tool-step-"));
}

const dispatchSupport = await getEmbeddedPostgresTestSupport();
const describeDispatchDb = dispatchSupport.supported ? describe : describe.skip;

describeDispatchDb("http workflow tool core dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-http-tool-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentToolGrants);
    await db.delete(toolDefinitions);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
    while (workDirs.length) {
      try {
        rmSync(workDirs.pop()!, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });


  async function seedCompanyAgent(companyName: string, workProductRoot?: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: companyName,
      issuePrefix: companyName.slice(0, 3).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
      ...(workProductRoot ? { workProductRoot } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operator",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("dispatches an http tool, resolves the step output dir, and preserves a 200 result", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "http-dispatch-wp-"));
    workDirs.push(workDir);
    const { companyId, agentId: ownerAgentId } = await seedCompanyAgent("HTTP Owner", workDir);
    const operatorAgentId = randomUUID();
    const toolId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "collect";

    await db.insert(agents).values({
      id: operatorAgentId,
      companyId,
      name: "Scout Operator",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "scout mission" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "scout" });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: ADAPTER_CONFIG,
    });
    await db.insert(agentToolGrants).values({ companyId, agentId: operatorAgentId, toolId, grantedBy: "board" });

    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId: operatorAgentId,
      toolName: "collect-http",
      parameters: { limit: 2 },
      requestId: "dispatch-200",
      workflowRunId: runId,
      stepId,
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });

    expect(result.status).toBe(200);
    const rawPath = join(workDir, "missions", missionId, "runs", runId, "steps", stepId, "raw-tech-scout.json");
    expect(result.body.data).toEqual({ ...RESULT, rawPath });
    expect(existsSync(rawPath)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("rejects an http tool without a grant with 403 and does not call the remote", async () => {
    const { companyId, agentId } = await seedCompanyAgent("No Grant");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: ADAPTER_CONFIG,
    });
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-http",
      parameters: { limit: 1 },
      requestId: "dispatch-no-grant",
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(result.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 422 for an http tool with an invalid adapter config and does not call the remote", async () => {
    const { companyId, agentId } = await seedCompanyAgent("Bad Config");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: { ...ADAPTER_CONFIG, url: "not-a-url" },
    });
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "board" });
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-http",
      parameters: { limit: 1 },
      requestId: "dispatch-bad-config",
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(result.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a plain http url without allowInsecureUrl with 422 and does not call the remote", async () => {
    const { companyId, agentId } = await seedCompanyAgent("Insecure Rejected");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: { ...ADAPTER_CONFIG, url: "http://n8n.example.test/webhook/daily-tech-scout" },
    });
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "board" });
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-http",
      parameters: { limit: 1 },
      requestId: "dispatch-insecure-rejected",
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(result.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches a plain http url when adapterConfig.allowInsecureUrl is true", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "http-dispatch-wp-"));
    workDirs.push(workDir);
    const { companyId, agentId: ownerAgentId } = await seedCompanyAgent("Insecure Allowed", workDir);
    const operatorAgentId = randomUUID();
    const toolId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "collect";

    await db.insert(agents).values({
      id: operatorAgentId,
      companyId,
      name: "Scout Operator",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "scout mission" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "scout" });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: {
        ...ADAPTER_CONFIG,
        url: "http://n8n.example.test/webhook/daily-tech-scout",
        allowInsecureUrl: true,
      },
    });
    await db.insert(agentToolGrants).values({ companyId, agentId: operatorAgentId, toolId, grantedBy: "board" });

    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId: operatorAgentId,
      toolName: "collect-http",
      parameters: { limit: 2 },
      requestId: "dispatch-insecure-allowed",
      workflowRunId: runId,
      stepId,
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });

    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe("http://n8n.example.test/webhook/daily-tech-scout");
    const rawPath = join(workDir, "missions", missionId, "runs", runId, "steps", stepId, "raw-tech-scout.json");
    expect(existsSync(rawPath)).toBe(true);
  });

  it("preserves a 500 remote failure for an http tool", async () => {
    const { companyId, agentId } = await seedCompanyAgent("Remote Fail");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-http",
      description: "http scout",
      adapterType: "http",
      adapterConfig: ADAPTER_CONFIG,
    });
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "board" });
    const fetchImpl = vi.fn(async () => makeFetchResponse(500, "remote boom")) as unknown as FetchLike;
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-http",
      parameters: { limit: 1 },
      requestId: "dispatch-500",
      remoteDeps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("keeps builtin tool execution behavior unchanged", async () => {
    const { companyId, agentId } = await seedCompanyAgent("Builtin");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-local",
      description: "builtin scout",
      adapterType: "builtin",
      adapterConfig: { command: 'node -e "console.log(JSON.stringify({ ok: true }))"' },
    });
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "board" });
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-local",
      parameters: {},
      requestId: "dispatch-builtin",
    });
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ok: true });
  });
});

describe("executeHttpWorkflowTool — data-only response contract", () => {
  const DATA_ONLY_CONFIG = {
    url: "https://n8n.example.test/webhook/shorts-storage",
    method: "POST",
    timeoutMs: 5000,
    auth: {
      type: "header",
      headerName: "X-Papercompany-Webhook-Key",
      secretId: "secret-1",
      version: "latest",
    },
    response: {
      resultField: "result",
      assertions: [{ field: "ok", equals: true }],
    },
  };

  function baseDeps(fetchImpl: FetchLike) {
    return { fetchImpl, resolveSecretValue: async () => SECRET_VALUE };
  }

  it("returns the declared result body as machine data without artifact handling", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { result: { ok: true, count: 22, total_bytes: 1234 } }),
    );
    const result = await executeHttpWorkflowTool(
      {
        companyId: "c1",
        toolName: "shorts-storage-list",
        parameters: { action: "list", prefix: "shorts/runs/r1/clips/" },
        requestId: "req-data-only-1",
        stepOutputDir: null,
        adapterConfig: DATA_ONLY_CONFIG,
      },
      baseDeps(fetchImpl as unknown as FetchLike),
    );
    expect(result.status).toBe(200);
    expect((result.body as { data?: unknown }).data).toEqual({ ok: true, count: 22, total_bytes: 1234 });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ action: "list", prefix: "shorts/runs/r1/clips/" }),
    );
  });

  it("fails closed when a declared assertion is violated (data-only)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { result: { ok: false, count: 0 } }),
    );
    const result = await executeHttpWorkflowTool(
      {
        companyId: "c1",
        toolName: "shorts-storage-list",
        parameters: {},
        requestId: "req-data-only-2",
        stepOutputDir: null,
        adapterConfig: DATA_ONLY_CONFIG,
      },
      baseDeps(fetchImpl as unknown as FetchLike),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error?: string }).error).toContain("response contract violated");
  });

  it("fails closed when the declared result field is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeFetchResponse(200, { unexpected: {} }));
    const result = await executeHttpWorkflowTool(
      {
        companyId: "c1",
        toolName: "shorts-storage-list",
        parameters: {},
        requestId: "req-data-only-3",
        stepOutputDir: null,
        adapterConfig: DATA_ONLY_CONFIG,
      },
      baseDeps(fetchImpl as unknown as FetchLike),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error?: string }).error).toContain("missing required fields");
  });

  it("rejects a mixed contract (artifactField without artifact fields) as invalid config", async () => {
    const fetchImpl = vi.fn();
    const result = await executeHttpWorkflowTool(
      {
        companyId: "c1",
        toolName: "mixed-tool",
        parameters: {},
        requestId: "req-data-only-4",
        stepOutputDir: null,
        adapterConfig: {
          ...DATA_ONLY_CONFIG,
          response: { resultField: "result", artifactField: "artifact" },
        },
      },
      baseDeps(fetchImpl as unknown as FetchLike),
    );
    expect(result.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps requiring a step output dir for artifact-producing tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeFetchResponse(200, { result: { ok: true }, artifact: { any: "payload" } }),
    );
    const artifactConfig = {
      ...DATA_ONLY_CONFIG,
      response: {
        resultField: "result",
        artifactField: "artifact",
        artifactFileName: "result.json",
        artifactPathResultField: "rawPath",
      },
    };
    const result = await executeHttpWorkflowTool(
      {
        companyId: "c1",
        toolName: "artifact-tool",
        parameters: {},
        requestId: "req-data-only-5",
        stepOutputDir: null,
        adapterConfig: artifactConfig,
      },
      baseDeps(fetchImpl as unknown as FetchLike),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error?: string }).error).toContain("step output directory");
  });
});
