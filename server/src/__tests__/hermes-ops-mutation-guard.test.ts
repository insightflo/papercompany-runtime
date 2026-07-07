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

  // [P3] mode-based allowlist 분기. advisor/supervision/relay은 직접 mutation 차단(각 모드의 허용 동작은
  //   supervision/run·comments relay 같은 별도 라우트). admin만 explicit operator 한정 허용.
  it("advisor mode blocks all guarded mutations and logs the mode", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    const middleware = hermesOpsMutationGuard("issue.work-products.create");
    const req = buildReq({
      type: "agent",
      agentId: "hermes-ops-1",
      source: "agent_jwt",
      isHermesOpsLiaison: true,
      hermesOpsMode: "advisor",
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mode: "advisor", action: "issue.work-products.create" }));
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ mode: "advisor" });
    warnSpy.mockRestore();
  });

  it("supervision mode blocks direct workflow/artifact mutation", () => {
    const middleware = hermesOpsMutationGuard("workflow.complete");
    const req = buildReq({
      type: "agent",
      agentId: "hermes-ops-1",
      isHermesOpsLiaison: true,
      hermesOpsMode: "supervision",
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("relay mode blocks workflow/artifact mutation (comments relay uses a separate unguarded route)", () => {
    const middleware = hermesOpsMutationGuard("workflow.verdict.submit");
    const req = buildReq({
      type: "agent",
      agentId: "hermes-ops-1",
      isHermesOpsLiaison: true,
      hermesOpsMode: "relay",
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admin mode allows guarded mutations (explicit operator elevation only)", () => {
    const middleware = hermesOpsMutationGuard("workflow.manual-complete");
    const req = buildReq({
      type: "agent",
      agentId: "hermes-ops-1",
      isHermesOpsLiaison: true,
      hermesOpsMode: "admin",
    });
    const res = buildRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  // [peer verify] 실제 route에 부착된 8개 action 전수 — advisor는 전부 차단, admin은 전부 허용.
  //   supervision/relay은 advisor와 동일(빈 allowlist)하므로 advisor 케이스로 대표 커버.
  const GUARDED_ROUTE_ACTIONS = [
    "workflow.artifacts.register",
    "workflow.verdict.submit",
    "workflow.complete",
    "workflow.manual-complete",
    "issue.work-products.create",
    "issue.work-products.update",
    "issue.work-products.delete",
    "issue.status.patch",
  ];
  for (const action of GUARDED_ROUTE_ACTIONS) {
    it(`advisor mode blocks every guarded route action: ${action}`, () => {
      const middleware = hermesOpsMutationGuard(action);
      const req = buildReq({
        type: "agent",
        agentId: "hermes-ops-1",
        isHermesOpsLiaison: true,
        hermesOpsMode: "advisor",
      });
      const res = buildRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ action, mode: "advisor" }));
    });

    it(`admin mode allows every guarded route action: ${action}`, () => {
      const middleware = hermesOpsMutationGuard(action);
      const req = buildReq({
        type: "agent",
        agentId: "hermes-ops-1",
        isHermesOpsLiaison: true,
        hermesOpsMode: "admin",
      });
      const res = buildRes();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  }
});
