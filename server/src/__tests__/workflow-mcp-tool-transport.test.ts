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
  capture?: { headers?: unknown; arguments?: unknown };
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
      if (opts.capture) {
        opts.capture.arguments = (body as { params?: { arguments?: unknown } }).params?.arguments;
      }
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

describe("mcp workflow tool adapter", () => {
  const stepDirs: string[] = [];

  afterEach(() => {
    while (stepDirs.length) {
      try {
        rmSync(stepDirs.pop()!, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("connects, calls the configured remote tool, and maps structuredContent to a 200 result", async () => {
    const capture: { headers?: unknown; arguments?: unknown } = {};
    const fetchImpl = makeMcpFetch({
      callResult: {
        content: [{ type: "text", text: "collected" }],
        structuredContent: { ok: true, count: 2, repos: [{ rank: 1 }] },
      },
      capture,
    });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 2 },
        requestId: "request-123",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(headerValue(capture.headers, "X-Papercompany-Webhook-Key")).toBe(SECRET_VALUE);
    expect(headerValue(capture.headers, "X-Papercompany-Request-Id")).toBe("request-123");
    expect(capture.arguments).toEqual({ limit: 2 });
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ok: true, count: 2, repos: [{ rank: 1 }] });
    expect(JSON.parse(result.body.content ?? "")).toEqual(result.body.data);
    expect(result.body.tool).toBe("research-scout");
    expect(result.body.source).toBe("core");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
  it("falls back to joined text content when structuredContent is absent", async () => {
    const fetchImpl = makeMcpFetch({
      callResult: { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] },
    });
    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ text: "hello\nworld" });
  });
  it("returns 403 without leaking the secret when the company secret cannot be resolved", async () => {
    const fetchImpl = makeMcpFetch({});
    const resolveSecretValue = vi.fn(async () => {
      throw new Error("Secret not found in company");
    });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: resolveSecretValue as never },
    );

    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("returns 403 for a remote 401 without leaking the secret", async () => {
    const fetchImpl = makeMcpFetch({ unauthorized: true });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("returns 500 with bounded diagnostics for a remote server error", async () => {
    const fetchImpl = makeMcpFetch({ callStatus: 500 });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-9",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(500);
    expect(result.body.error ?? "").not.toContain(SECRET_VALUE);
  });

  it("returns 500 with a timeout message and request id on a request timeout", async () => {
    const fetchImpl = makeMcpFetch({ hangOnCall: true });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-timeout",
        stepOutputDir: null,
        adapterConfig: { ...MCP_CONFIG, timeoutMs: 40 },
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(500);
    expect(result.body.error ?? "").toContain("timed out");
    expect(result.body.error ?? "").toContain("request-timeout");
    expect(result.body.error ?? "").not.toContain(SECRET_VALUE);
  });

  it("returns 500 for a malformed response with no content or structuredContent", async () => {
    const fetchImpl = makeMcpFetch({ callResult: { content: [] } });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(500);
  });

  it("returns 500 for a tool-reported error and bounds the diagnostic", async () => {
    const fetchImpl = makeMcpFetch({
      callResult: { isError: true, content: [{ type: "text", text: "tool failed detail" }] },
    });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(500);
    expect(result.body.error ?? "").toContain("tool failed detail");
  });

});
