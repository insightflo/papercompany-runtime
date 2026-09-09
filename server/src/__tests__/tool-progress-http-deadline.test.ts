import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";

const input = {
  companyId: "00000000-0000-4000-8000-000000000001", toolName: "deadline", parameters: {}, requestId: "deadline-test",
  adapterConfig: { url: "https://example.test/tool", method: "POST", timeoutMs: 900_000,
    auth: { type: "header", headerName: "Authorization", secretId: "test", version: "latest" },
    response: { resultField: "result" } },
};
afterEach(() => vi.useRealTimers());
describe("fixed HTTP deadlines", () => {
  it("honors 900000ms rather than truncating to five minutes", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = executeHttpWorkflowTool(input, {
      resolveSecretValue: async () => "fixture-auth",
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(599_999);
    expect((await pending).body.error).toContain("timed out");
  });
  it.each([200, 500])("bounds a stalled %s body even when fetch ignores abort", async (status) => {
    vi.useFakeTimers();
    let settled = false;
    const pending = executeHttpWorkflowTool({ ...input, adapterConfig: { ...input.adapterConfig, timeoutMs: 1000 } }, {
      resolveSecretValue: async () => "fixture-auth",
      fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status }),
    }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(true);
    expect((await pending).body.error).toContain("timed out");
  });
  it.each([NaN, Infinity, -1, 0, 2147483648, "1000"])("rejects invalid timeout %s before dispatch", async (timeoutMs) => {
    let dispatched = false;
    const result = await executeHttpWorkflowTool({ ...input, adapterConfig: { ...input.adapterConfig, timeoutMs } }, {
      resolveSecretValue: async () => "fixture-auth",
      fetchImpl: async () => { dispatched = true; return Response.json({ result: {} }); },
    });
    expect(result.status).toBe(422);
    expect(dispatched).toBe(false);
  });
});
