import { beforeEach, describe, expect, it, vi } from "vitest";

// The 2026-09-16 shorts-assemble incident: Node's bundled fetch (undici)
// silently aborts a request whose response HEADERS have not arrived within
// the undici default headersTimeout of 300_000ms — regardless of the tool's
// configured timeoutMs/progress maxDurationMs. Services that compute the
// whole response before sending headers (sync assembly) therefore die at
// ~5 minutes even when the tool allows 15+. The adapter must dispatch
// through a shared undici Agent whose transport timeouts are effectively
// disabled, so the adapter's own deadline machinery stays authoritative.
const agentInstances: Array<Record<string, unknown>> = [];
const undiciFetchSentinel = vi.fn(async () => Response.json({ result: { ok: true } }));
vi.mock("undici", () => ({
  Agent: vi.fn((options: Record<string, unknown>) => {
    const agent = { __agent: true, options };
    agentInstances.push(agent);
    return agent;
  }),
  fetch: undiciFetchSentinel,
}));

const input = {
  companyId: "00000000-0000-4000-8000-000000000001",
  toolName: "slow-sync-tool",
  parameters: {},
  requestId: "dispatcher-test",
  adapterConfig: {
    url: "https://example.test/tool",
    method: "POST",
    timeoutMs: 900_000,
    auth: { type: "header", headerName: "Authorization", secretId: "test", version: "latest" },
    response: { resultField: "result" },
  },
};

describe("HTTP tool dispatcher transport timeouts", () => {
  beforeEach(() => {
    agentInstances.length = 0;
    undiciFetchSentinel.mockClear();
    vi.resetModules();
  });

  it("builds one shared agent with transport waits at the Node timer ceiling", async () => {
    const { httpDispatcher } = await import("../services/workflow/http-tool-dispatcher.js");
    const a = httpDispatcher();
    const b = httpDispatcher();
    expect(a).toBe(b);
    expect(agentInstances).toHaveLength(1);
    expect(agentInstances[0]!.options).toEqual({
      headersTimeout: 2_147_483_647,
      bodyTimeout: 2_147_483_647,
      connect: { timeout: 2_147_483_647 },
    });
  });

  it("passes a dispatcher to fetch so undici defaults cannot cut the call short", async () => {
    const { executeHttpWorkflowTool } = await import("../services/workflow/http-tool-adapter.js");
    let seenInit: (RequestInit & { dispatcher?: unknown }) | undefined;
    await executeHttpWorkflowTool(input, {
      resolveSecretValue: async () => "fixture-auth",
      fetchImpl: async (_url, init) => {
        seenInit = init ?? undefined;
        return Response.json({ result: { ok: true } });
      },
    });
    expect(seenInit?.dispatcher).toBeDefined();
  });

  it("defaults to the undici package fetch, not the global fetch", async () => {
    const { executeHttpWorkflowTool } = await import("../services/workflow/http-tool-adapter.js");
    const result = await executeHttpWorkflowTool(input, {
      resolveSecretValue: async () => "fixture-auth",
    });
    expect(undiciFetchSentinel).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });
});
