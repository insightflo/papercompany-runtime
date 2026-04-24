import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const mocks = vi.hoisted(() => ({
  createFromSrb: vi.fn(),
  insertSrbDeliveryLog: vi.fn(),
  heartbeatWakeup: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    createFromSrb: mocks.createFromSrb,
  }),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: mocks.heartbeatWakeup,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../services/srb/shared.js", () => ({
  insertSrbDeliveryLog: mocks.insertSrbDeliveryLog,
}));

import { applySrbInboundReceiveSideEffects, createSrbInboundHandler } from "../services/srb/inbound.js";

describe("createSrbInboundHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heartbeatWakeup.mockResolvedValue({ id: "run-1" });
  });

  it("returns post-commit side effects without firing them inside receive", async () => {
    const assigneeAgentId = randomUUID();
    mocks.createFromSrb.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Inbound mirror",
      identifier: "OPS-41",
      assigneeAgentId,
      status: "todo",
    });
    mocks.insertSrbDeliveryLog.mockResolvedValue({ id: "delivery-1" });

    const handler = createSrbInboundHandler({} as never);
    const result = await handler.receive({} as never, {
      linkId: "link-1",
      targetCompanyId: "company-1",
      event: "issue.created",
      payload: {
        title: "Inbound mirror",
        status: "todo",
        assigneeAgentId,
      },
      idempotencyKey: "nonce-1",
    });

    expect(result).toEqual({
      deliveryId: "delivery-1",
      issueId: "issue-1",
      issueIdentifier: "OPS-41",
      status: "received",
      postCommit: {
        actorId: "link-1",
        issue: {
          id: "issue-1",
          companyId: "company-1",
          title: "Inbound mirror",
          identifier: "OPS-41",
          assigneeAgentId,
          status: "todo",
        },
      },
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.heartbeatWakeup).not.toHaveBeenCalled();
  });

  it("applies inbound post-commit side effects after persistence succeeds", async () => {
    mocks.heartbeatWakeup.mockResolvedValue({ id: "run-1" });

    await applySrbInboundReceiveSideEffects({
      db: {} as never,
      heartbeat: { wakeup: mocks.heartbeatWakeup } as never,
      postCommit: {
        actorId: "link-1",
        issue: {
          id: "issue-1",
          companyId: "company-1",
          title: "Inbound mirror",
          identifier: "OPS-41",
          assigneeAgentId: "agent-1",
          status: "todo",
        },
      },
    });

    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "system",
      actorId: "link-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
      details: { title: "Inbound mirror", identifier: "OPS-41" },
    }));
    expect(mocks.heartbeatWakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: "issue-1", mutation: "create" },
      contextSnapshot: { issueId: "issue-1", source: "srb.issue.create" },
      requestedByActorType: "system",
      requestedByActorId: "link-1",
    }));
  });

  it("does not enqueue wakeups when receive fails before commit", async () => {
    mocks.createFromSrb.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Inbound mirror",
      identifier: "OPS-41",
      assigneeAgentId: "agent-1",
      status: "todo",
    });
    mocks.insertSrbDeliveryLog.mockRejectedValue(new Error("persist failed"));

    const handler = createSrbInboundHandler({} as never);
    await expect(
      handler.receive({} as never, {
        linkId: "link-1",
        targetCompanyId: "company-1",
        event: "issue.created",
        payload: {
          title: "Inbound mirror",
          status: "todo",
          assigneeAgentId: randomUUID(),
        },
        idempotencyKey: "nonce-1",
      }),
    ).rejects.toThrow("persist failed");

    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.heartbeatWakeup).not.toHaveBeenCalled();
  });
});
