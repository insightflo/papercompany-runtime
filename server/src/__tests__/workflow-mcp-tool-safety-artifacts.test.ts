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

  it("normalizes non-object parameters to an empty MCP arguments object", async () => {
    const capture: { arguments?: unknown } = {};
    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: ["unexpected"],
        requestId: "request-array",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      {
        fetchImpl: makeMcpFetch({ capture }) as never,
        resolveSecretValue: defaultResolveSecretValue(),
      },
    );
    expect(result.status).toBe(200);
    expect(capture.arguments).toEqual({});
  });

  it("strips the resolved secret from a remote diagnostic that echoes it back", async () => {
    const fetchImpl = makeMcpFetch({ callStatus: 500, remoteText: `server saw header ${SECRET_VALUE} and rejected` });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 1 },
        requestId: "request-leak",
        stepOutputDir: null,
        adapterConfig: MCP_CONFIG,
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("strips the resolved secret from a tool-reported error content", async () => {
    const fetchImpl = makeMcpFetch({
      callResult: { isError: true, content: [{ type: "text", text: `config had ${SECRET_VALUE}` }] },
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
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("rejects invalid configuration with 422", async () => {
    const fetchImpl = makeMcpFetch({});
    const deps = { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() };

    const noUrl = await executeMcpWorkflowTool(
      { companyId: "company-1", toolName: "research-scout", parameters: {}, requestId: "r", stepOutputDir: null, adapterConfig: { ...MCP_CONFIG, url: "" } },
      deps,
    );
    expect(noUrl.status).toBe(422);

    const nonHttps = await executeMcpWorkflowTool(
      { companyId: "company-1", toolName: "research-scout", parameters: {}, requestId: "r", stepOutputDir: null, adapterConfig: { ...MCP_CONFIG, url: "http://insecure.test/mcp" } },
      deps,
    );
    expect(nonHttps.status).toBe(422);

    const malformedHttps = await executeMcpWorkflowTool(
      { companyId: "company-1", toolName: "research-scout", parameters: {}, requestId: "r", stepOutputDir: null, adapterConfig: { ...MCP_CONFIG, url: "https://" } },
      deps,
    );
    expect(malformedHttps.status).toBe(422);

    const noToolName = await executeMcpWorkflowTool(
      { companyId: "company-1", toolName: "research-scout", parameters: {}, requestId: "r", stepOutputDir: null, adapterConfig: { ...MCP_CONFIG, toolName: "" } },
      deps,
    );
    expect(noToolName.status).toBe(422);

    const badAuth = await executeMcpWorkflowTool(
      { companyId: "company-1", toolName: "research-scout", parameters: {}, requestId: "r", stepOutputDir: null, adapterConfig: { ...MCP_CONFIG, auth: { type: "header", headerName: "X-Key" } } },
      deps,
    );
    expect(badAuth.status).toBe(422);
  });

  it("persists a configured artifact from structuredContent into the step output dir", async () => {
    const stepDir = mkdtempSync(join(tmpdir(), "mcp-tool-step-"));
    stepDirs.push(stepDir);
    const fetchImpl = makeMcpFetch({
      callResult: {
        content: [{ type: "text", text: "collected" }],
        structuredContent: {
          summary: { ok: true },
          evidence: { ok: true, repos: [{ rank: 1, full_name: "owner/repo" }] },
        },
      },
    });

    const result = await executeMcpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "research-scout",
        parameters: { limit: 2 },
        requestId: "request-artifact",
        stepOutputDir: stepDir,
        adapterConfig: {
          ...MCP_CONFIG,
          response: {
            artifactField: "evidence",
            artifactFileName: "raw-tech-scout.json",
            artifactPathResultField: "rawPath",
          },
        },
      },
      { fetchImpl: fetchImpl as never, resolveSecretValue: defaultResolveSecretValue() },
    );

    expect(result.status).toBe(200);
    const rawPath = join(stepDir, "raw-tech-scout.json");
    const data = result.body.data as Record<string, unknown>;
    expect(data.rawPath).toBe(rawPath);
    expect(JSON.parse(result.body.content ?? "")).toEqual(data);
    const artifact = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(rawPath, "utf8")));
    expect(artifact).toEqual({ ok: true, repos: [{ rank: 1, full_name: "owner/repo" }] });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
});
