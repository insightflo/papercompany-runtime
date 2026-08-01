import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeMcpWorkflowTool } from "../services/workflow/mcp-tool-adapter.js";
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

const SECRET_VALUE = "test-webhook-secret";

const MCP_CONFIG = {
  url: "https://mcp.example.test/mcp",
  toolName: "daily-tech-scout",
  timeoutMs: 5_000,
  auth: {
    type: "header",
    headerName: "X-Papercompany-Webhook-Key",
    secretId: "secret-1",
    version: "latest",
  },
};

type FetchInit = { headers?: unknown; body?: string | null; signal?: AbortSignal };

function mcpJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function makeMcpFetch(opts: {
  callResult?: unknown;
  callStatus?: number;
  remoteText?: string;
  hangOnCall?: boolean;
  unauthorized?: boolean;
  capture?: { headers?: unknown };
}) {
  return async (_url: string | URL, init?: FetchInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number | string };
    if (opts.capture) opts.capture.headers = init?.headers;

    if (opts.unauthorized) {
      return mcpJson({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" } }, 401);
    }

    if (body.method === "initialize") {
      return mcpJson({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-mcp", version: "1.0.0" },
        },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      if (opts.hangOnCall) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
          if (signal) {
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }
        });
      }
      const status = opts.callStatus ?? 200;
      if (status !== 200) {
        if (opts.remoteText !== undefined) {
          return new Response(opts.remoteText, { status, headers: { "content-type": "text/plain" } });
        }
        return mcpJson({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "remote boom" } }, status);
      }
      return mcpJson({
        jsonrpc: "2.0",
        id: body.id,
        result: opts.callResult ?? { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  };
}

function defaultResolveSecretValue(): (companyId: string, secretId: string, version: number | "latest") => Promise<string> {
  return vi.fn(async () => SECRET_VALUE) as never;
}

const dispatchSupport = await getEmbeddedPostgresTestSupport();
const describeDispatchDb = dispatchSupport.supported ? describe : describe.skip;

describeDispatchDb("mcp workflow tool core dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-tool-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

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

  it("dispatches an mcp tool and preserves a 200 result", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mcp-dispatch-wp-"));
    workDirs.push(workDir);
    const { companyId, agentId: ownerAgentId } = await seedCompanyAgent("MCP Owner", workDir);
    const toolId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "scout mission" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "scout" });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-mcp",
      description: "mcp scout",
      adapterType: "mcp",
      adapterConfig: MCP_CONFIG,
    });
    await db.insert(agentToolGrants).values({ companyId, agentId: ownerAgentId, toolId, grantedBy: "board" });

    const fetchImpl = makeMcpFetch({
      callResult: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true, count: 1 } },
    });
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId: ownerAgentId,
      toolName: "collect-mcp",
      parameters: { limit: 1 },
      requestId: "mcp-dispatch-200",
      workflowRunId: runId,
      stepId: "collect",
      remoteDeps: { fetchImpl: fetchImpl as never, resolveSecretValue: async () => SECRET_VALUE },
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ok: true, count: 1 });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("rejects an mcp tool without a grant with 403", async () => {
    const { companyId, agentId } = await seedCompanyAgent("MCP No Grant");
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "collect-mcp",
      description: "mcp scout",
      adapterType: "mcp",
      adapterConfig: MCP_CONFIG,
    });
    const fetchImpl = makeMcpFetch({});
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "collect-mcp",
      parameters: { limit: 1 },
      requestId: "mcp-no-grant",
      remoteDeps: { fetchImpl: fetchImpl as never, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(result.status).toBe(403);
  });
});
