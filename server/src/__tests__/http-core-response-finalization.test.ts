import { beforeEach, describe, expect, it, vi } from "vitest";

const receipt = vi.hoisted(() => ({ complete: vi.fn(), release: vi.fn() }));
vi.mock("../services/plugin-tool-execution-receipt.js", () => ({
  completeToolExecutionReceipt: receipt.complete, releaseToolExecutionReceipt: receipt.release,
}));
import { finalizeHttpCoreResponse, isPositiveHttpDeferral } from "../services/http-core-response-finalization.js";

const identity = { requestId: "request", executionId: "run", attemptId: "attempt", executionGeneration: 1 };
const deferred = { ...identity, kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down", externalStarted: false };
describe("HTTP core result finalization", () => {
  beforeEach(() => vi.resetAllMocks());
  it("accepts a deferral only for the expected execution", () => {
    expect(isPositiveHttpDeferral(deferred, identity)).toBe(true);
    expect(isPositiveHttpDeferral(deferred, { ...identity, attemptId: "other" })).toBe(false);
  });
  it("saves the receipt before sending the response", async () => {
    const events: string[] = [];
    receipt.complete.mockImplementation(async () => { events.push("saved"); });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(() => events.push("sent")) };
    await finalizeHttpCoreResponse({ db: {} as never, req: {} as never, res: res as never,
      receipt: { id: "receipt", companyId: "company", runId: "run", tool: "tool" },
      originalResult: {}, response: { status: 200, body: { ok: true } },
      workflowAuditScope: { workflowRunId: null, stepId: null }, disposition: "complete" });
    expect(events).toEqual(["saved", "sent"]);
  });
  it("holds finalization and never sends when receipt storage fails", async () => {
    const error = new Error("storage failed");
    receipt.release.mockRejectedValue(error);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }, lifetime = { holdFinalization: vi.fn() };
    await expect(finalizeHttpCoreResponse({ db: {} as never, req: {} as never, res: res as never,
      lifetime: lifetime as never, receipt: { id: "receipt", companyId: "company", runId: "run", tool: "tool" },
      originalResult: {}, response: { status: 503, body: {} },
      workflowAuditScope: { workflowRunId: null, stepId: null }, disposition: "release" })).rejects.toBe(error);
    expect(lifetime.holdFinalization).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });
});
