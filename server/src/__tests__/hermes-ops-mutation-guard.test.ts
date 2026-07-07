import { describe, expect, it, vi } from "vitest";
import { hermesOpsMutationGuard } from "../middleware/hermes-ops-mutation-guard.js";
import { logger } from "../middleware/logger.js";

// [목적] hermesOpsMutationGuard의 liaison 차단/허용 분기와 로그 context를 검증.
//   route 부착 자체는 grep + typecheck로 별도 검증(8 라우트).
function buildReq(actor: Record<string, unknown>, params: Record<string, string> = {}) {
  return {
    method: "POST",
    originalUrl: "/api/issues/iss-1/workflow/complete",
    params,
    actor,
  } as any;
}

function buildRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

describe("hermesOpsMutationGuard", () => {
  it("blocks operations-liaison agent with 403 and structured error", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    const middleware = hermesOpsMutationGuard("workflow.complete");
    const req = buildReq(
      {
        type: "agent",
        agentId: "hermes-ops-1",
        runId: "run-1",
        companyId: "co-1",
        source: "agent_jwt",
        isHermesOpsLiaison: true,
      },
      { id: "iss-1" },
    );
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "hermes_ops_mutation_forbidden",
        action: "workflow.complete",
      }),
    );
    // [주의] deny 로그에 agent/run/issue context가 남아야 함(peer 요구사항).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logPayload = warnSpy.mock.calls[0][0];
    expect(logPayload).toMatchObject({
      action: "workflow.complete",
      agentId: "hermes-ops-1",
      runId: "run-1",
      companyId: "co-1",
      issueId: "iss-1",
    });
    warnSpy.mockRestore();
  });

  it("allows non-liaison agent (flag false)", () => {
    const middleware = hermesOpsMutationGuard("issue.status.patch");
    const req = buildReq({
      type: "agent",
      agentId: "producer-1",
      runId: "run-2",
      source: "agent_jwt",
      isHermesOpsLiaison: false,
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows board actor (flag undefined — board path not identifiable as liaison)", () => {
    const middleware = hermesOpsMutationGuard("workflow.manual-complete");
    const req = buildReq({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows when actor has no liaison flag at all (defensive)", () => {
    const middleware = hermesOpsMutationGuard("workflow.artifacts.register");
    const req = buildReq({ type: "agent", agentId: "agent-x", source: "agent_key" });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
