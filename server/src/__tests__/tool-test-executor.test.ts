import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  toolDefinitions,
} from "@paperclipai/db";
import type { ToolDefinition } from "../services/tools/types.js";
import { executeToolTest } from "../services/tools/test-executor.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const SECRET_VALUE = "super-secret-token-12345";

const HTTP_CONFIG = {
  url: "https://example.test/webhook/tool",
  method: "POST",
  timeoutMs: 5000,
  auth: { type: "header", headerName: "X-Api-Key", secretId: "secret-1", version: "latest" },
  response: {
    resultField: "result",
    artifactField: "artifact",
    artifactFileName: "out.json",
    artifactPathResultField: "rawPath",
  },
};

const MCP_CONFIG = {
  url: "https://example.test/mcp",
  toolName: "remote-tool",
  timeoutMs: 5000,
  auth: { type: "header", headerName: "Authorization", secretId: "secret-1", version: "latest" },
};

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "tool-1",
    companyId: "company-1",
    name: "test-tool",
    description: "",
    inputSchema: {},
    adapterType: "http",
    adapterConfig: {},
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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

const NO_DB = null as unknown as Db;

describe("tool test executor (no-db logic)", () => {
  it("returns a clear failure for a disabled tool", async () => {
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ enabled: false }),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("failure");
    expect(outcome.httpStatus).toBe(403);
    expect(outcome.error).toContain("disabled");
  });

  it("rejects a tool that belongs to another company", async () => {
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ companyId: "company-2", adapterType: "http", adapterConfig: HTTP_CONFIG }),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("error");
    expect(outcome.httpStatus).toBe(403);
  });

  it("rejects an unsupported adapter type", async () => {
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "plugin" as ToolDefinition["adapterType"] }),
      input: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(501);
  });

  it("routes a plugin-provided tool through the dispatcher before core fallback", async () => {
    const getTool = vi.fn(() => ({ namespacedName: "acme:tool" }));
    const executeTool = vi.fn(async () => ({
      pluginId: "acme",
      toolName: "tool",
      result: { content: JSON.stringify({ ok: true }), data: { ok: true } },
    }));
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "builtin", adapterConfig: { source: "tool-registry" } }),
      input: {},
      dispatcher: { getTool, executeTool },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("success");
    expect(getTool).toHaveBeenCalledWith("test-tool");
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("converts a plugin tool error into a failure outcome without exposing secrets", async () => {
    const executeTool = vi.fn(async () => ({
      pluginId: "acme",
      toolName: "tool",
      result: { error: `auth failed for ${SECRET_VALUE}` },
    }));
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({
        adapterType: "builtin",
        adapterConfig: { source: "tool-registry", auth: { type: "header", headerName: "X-Key", secretId: "s1", version: "latest" } },
      }),
      input: {},
      dispatcher: { getTool: () => ({}), executeTool },
      deps: { resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("error");
    // The auth secret is redacted from the returned error.
    expect(outcome.error).not.toContain(SECRET_VALUE);
    expect(outcome.error).toContain("auth failed for");
  });

  it("falls back to core execution when the dispatcher has no registered plugin tool", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: { ok: true }, artifact: {} })) as unknown as FetchLike;
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "http", adapterConfig: HTTP_CONFIG }),
      input: {},
      deps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
      dispatcher: { getTool: () => null, executeTool: vi.fn() },
    });
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses the real http adapter and redacts the resolved secret from the result", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(200, {
        result: { ok: true, echo: SECRET_VALUE },
        artifact: { data: "x" },
      }),
    ) as unknown as FetchLike;
    const resolveSecretValue = vi.fn(async () => SECRET_VALUE);

    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "http", adapterConfig: HTTP_CONFIG }),
      input: { limit: 1 },
      deps: { fetchImpl, resolveSecretValue },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("success");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The header auth value was resolved through the real adapter path.
    expect(resolveSecretValue).toHaveBeenCalledWith("company-1", "secret-1", "latest");
    // Resolved secret must never appear in the returned result.
    expect(JSON.stringify(outcome.result)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
  });

  it("reports an auth failure when the secret cannot be resolved", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: {}, artifact: {} })) as unknown as FetchLike;
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "http", adapterConfig: HTTP_CONFIG }),
      input: {},
      deps: { fetchImpl, resolveSecretValue: async () => { throw new Error("nope"); } },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 422 for an http tool with an invalid config and does not call the remote", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: {}, artifact: {} })) as unknown as FetchLike;
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "http", adapterConfig: { ...HTTP_CONFIG, url: "not-a-url" } }),
      input: {},
      deps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(outcome.httpStatus).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates mcp adapter config without contacting the remote", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, {})) as unknown as FetchLike;
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "mcp", adapterConfig: { ...MCP_CONFIG, url: "" } }),
      input: {},
      deps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(outcome.httpStatus).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts the secret from a remote failure diagnostic", async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse(500, `server saw ${SECRET_VALUE} and failed`),
    ) as unknown as FetchLike;
    const outcome = await executeToolTest({
      db: NO_DB,
      companyId: "company-1",
      tool: makeTool({ adapterType: "http", adapterConfig: HTTP_CONFIG }),
      input: {},
      deps: { fetchImpl, resolveSecretValue: async () => SECRET_VALUE },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(500);
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
  });
});

const builtinSupport = await getEmbeddedPostgresTestSupport();
const describeBuiltinDb = builtinSupport.supported ? describe : describe.skip;

describeBuiltinDb("tool test executor (builtin reuse)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-test-exec-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(toolDefinitions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("runs a builtin tool through the real core executor and returns success", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Builtin Test",
      issuePrefix: "BLT",
      requireBoardApprovalForNewAgents: false,
    });
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "echo-tool",
      description: "echo",
      adapterType: "builtin",
      adapterConfig: { command: 'node -e "console.log(JSON.stringify({ ok: true }))"' },
    });
    const [tool] = await db
      .select()
      .from(toolDefinitions)
      .where(eq(toolDefinitions.id, toolId))
      .limit(1);

    const outcome = await executeToolTest({
      db,
      companyId,
      tool: tool as unknown as ToolDefinition,
      input: {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("success");
    expect(outcome.result).toEqual({ ok: true });
  });
});
