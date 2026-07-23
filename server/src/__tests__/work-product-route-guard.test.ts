import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const getIssueExecutionCardMock = vi.fn();
vi.mock("../services/issue-execution-cards/store.js", () => ({
  getIssueExecutionCard: (input: unknown) => getIssueExecutionCardMock(input),
}));

import { resolveAgentWorkProductRouteGuard } from "../services/issue-execution-cards/work-product-route-guard.js";

function createUnusedDb(): Pick<Db, "select" | "insert" | "update"> {
  const fail = () => {
    throw new Error("getIssueExecutionCard is mocked; DB should not be used in this test");
  };
  return {
    select: fail,
    insert: fail,
    update: fail,
  };
}

describe("resolveAgentWorkProductRouteGuard", () => {
  beforeEach(() => {
    getIssueExecutionCardMock.mockReset();
  });

  it("blocks agent POST when card requires workProduct and guides to durable Workflow API registration", async () => {
    getIssueExecutionCardMock.mockResolvedValue({
      contentHash: "cardhash-9",
      cardJson: {
        requiredOutputs: { workProduct: { required: true, outputDir: "/runs/out/sector-rotation" } },
      },
    });

    const decision = await resolveAgentWorkProductRouteGuard({
      db: createUnusedDb(),
      companyId: "c1",
      issueId: "i1",
      actorType: "agent",
    });

    expect(decision.block).toBe(true);
    expect(decision.reason).toBe("workflow_card_requires_artifact_marker");
    expect(decision.issueExecutionCardHash).toBe("cardhash-9");
    expect(decision.message).toContain("POST /api/issues/:id/workflow/artifacts");
    expect(decision.message).toContain("type=preview_url");
    expect(decision.message).toContain("Do not emit an `[ARTIFACT]` marker");
    expect(decision.message).toContain("Comments, stdout, and artifact markers are not registration authority");
    expect(decision.message).toContain("Do not POST /api/issues/:id/work-products");
    expect(decision.message).toContain("issueExecutionCardHash=cardhash-9");
    expect(decision.message).toContain("/runs/out/sector-rotation");
    expect(decision.message).not.toMatch(/\[ARTIFACT\]:\s*<absolute path>/);
  });

  it("allows agent POST when no execution card exists (non-workflow / general issue)", async () => {
    getIssueExecutionCardMock.mockResolvedValue(null);

    const decision = await resolveAgentWorkProductRouteGuard({
      db: createUnusedDb(),
      companyId: "c1",
      issueId: "i1",
      actorType: "agent",
    });

    expect(decision.block).toBe(false);
    expect(decision.reason).toBe("ok");
  });

  it("allows agent POST when card exists but workProduct not required", async () => {
    getIssueExecutionCardMock.mockResolvedValue({
      contentHash: "cardhash-info",
      cardJson: { requiredOutputs: { workProduct: { required: false } } },
    });

    const decision = await resolveAgentWorkProductRouteGuard({
      db: createUnusedDb(),
      companyId: "c1",
      issueId: "i1",
      actorType: "agent",
    });

    expect(decision.block).toBe(false);
  });

  it("allows non-agent (board/manual/user) POST even when card requires workProduct", async () => {
    getIssueExecutionCardMock.mockResolvedValue({
      contentHash: "cardhash-9",
      cardJson: { requiredOutputs: { workProduct: { required: true } } },
    });

    const userDecision = await resolveAgentWorkProductRouteGuard({
      db: createUnusedDb(),
      companyId: "c1",
      issueId: "i1",
      actorType: "user",
    });
    const boardDecision = await resolveAgentWorkProductRouteGuard({
      db: createUnusedDb(),
      companyId: "c1",
      issueId: "i1",
      actorType: "board",
    });

    expect(userDecision.block).toBe(false);
    expect(boardDecision.block).toBe(false);
  });
});
