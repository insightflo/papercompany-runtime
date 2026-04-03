import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  srbLinks,
  type Db,
} from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  resolveSecretValue: vi.fn(),
  sendSrbWebhookRequest: vi.fn(),
  insertSrbDeliveryLog: vi.fn(),
  updateSrbDeliveryLog: vi.fn(),
  inboundReceive: vi.fn(),
  recordSrbSuccess: vi.fn(),
  recordSrbFailure: vi.fn(),
  srbWebhookDeliveriesInc: vi.fn(),
  srbRetryTransitionsInc: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  srbLinks: {
    id: "srb_links.id",
    localCompanyId: "srb_links.local_company_id",
    remoteCompanyId: "srb_links.remote_company_id",
    remoteServerUrl: "srb_links.remote_server_url",
    sharedSecretId: "srb_links.shared_secret_id",
  },
  srbDeliveryLog: {
    id: "srb_delivery_log.id",
    linkId: "srb_delivery_log.link_id",
    status: "srb_delivery_log.status",
    nextRetryAt: "srb_delivery_log.next_retry_at",
  },
}));

vi.mock("../services/srb/router.js", () => ({
  createSRBRouter: () => ({ route: mocks.route }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: mocks.resolveSecretValue }),
}));

vi.mock("../routes/metrics.js", () => ({
  srbWebhookDeliveries: { inc: mocks.srbWebhookDeliveriesInc },
  srbRetryTransitions: { inc: mocks.srbRetryTransitionsInc },
}));

vi.mock("../services/alert-rules.js", () => ({
  getAlertRules: () => ({
    recordSrbSuccess: mocks.recordSrbSuccess,
    recordSrbFailure: mocks.recordSrbFailure,
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../services/srb/inbound.js", () => ({
  createSrbInboundHandler: () => ({ receive: mocks.inboundReceive }),
}));

vi.mock("../services/srb/shared.js", async () => {
  const actual = await vi.importActual<typeof import("../services/srb/shared.js")>(
    "../services/srb/shared.js",
  );
  return {
    ...actual,
    sendSrbWebhookRequest: mocks.sendSrbWebhookRequest,
    insertSrbDeliveryLog: mocks.insertSrbDeliveryLog,
    updateSrbDeliveryLog: mocks.updateSrbDeliveryLog,
  };
});

import { createDeliveryRetryWorker } from "../services/srb/delivery-retry-worker.js";
import { createLocalDispatch } from "../services/srb/local-dispatch.js";
import { createWebhookDispatch } from "../services/srb/webhook-dispatch.js";

function createRetryUpdateMock(options: { claimRows: unknown[]; setCalls: Record<string, unknown>[] }) {
  let callCount = 0;
  return vi.fn(() => ({
    set: vi.fn((payload: Record<string, unknown>) => {
      options.setCalls.push(payload);
      return {
        where: vi.fn(() => {
          callCount += 1;
          if (callCount === 1) {
            return {
              returning: vi.fn(async () => options.claimRows),
            };
          }
          return [];
        }),
      };
    }),
  }));
}

describe("P6 SRB dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("webhook dispatch persists original payload for retries", async () => {
    const link = {
      id: "link-1",
      localCompanyId: "company-local",
      remoteCompanyId: "company-remote",
      remoteServerUrl: "https://remote.example/api/srb/webhook",
      direction: "outbound",
      sharedSecretId: "secret-1",
      createdBy: "user-1",
      createdAt: new Date(),
    };
    mocks.route.mockResolvedValue({ path: "webhook", linkId: link.id, ...link });
    mocks.resolveSecretValue.mockResolvedValue("super-secret");
    mocks.insertSrbDeliveryLog.mockResolvedValue({ id: "delivery-1" });
    mocks.updateSrbDeliveryLog.mockResolvedValue(undefined);
    mocks.sendSrbWebhookRequest.mockResolvedValue({ ok: true, status: 200 });

    const dispatch = createWebhookDispatch({} as Db);
    const result = await dispatch.dispatch({
      linkId: link.id,
      event: "issue.created",
      payload: { title: "Mirror this" },
      timestamp: 1743550000,
      idempotencyKey: "nonce-1",
    });

    expect(result).toMatchObject({
      path: "webhook",
      deliveryId: "delivery-1",
      status: "delivered",
      httpStatus: 200,
      nextRetryAt: null,
    });
    expect(mocks.insertSrbDeliveryLog).toHaveBeenCalledWith(expect.anything(), {
      linkId: link.id,
      event: "issue.created",
      payload: { title: "Mirror this" },
      idempotencyKey: "nonce-1",
      status: "pending",
      attemptCount: 0,
    });
    expect(mocks.sendSrbWebhookRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: link.remoteServerUrl,
      body: JSON.stringify({ event: "issue.created", payload: { title: "Mirror this" } }),
      headers: expect.objectContaining({
        "X-SRB-Link-Id": link.id,
        "X-SRB-Idempotency-Key": "nonce-1",
      }),
    }));
    expect(mocks.updateSrbDeliveryLog).toHaveBeenCalledWith(expect.anything(), "delivery-1", expect.objectContaining({
      status: "delivered",
      attemptCount: 1,
    }));
    expect(mocks.recordSrbSuccess).toHaveBeenCalledTimes(1);
  });

  it("webhook dispatch schedules retry on failed response", async () => {
    const link = {
      id: "link-2",
      localCompanyId: "company-local",
      remoteCompanyId: "company-remote",
      remoteServerUrl: "https://remote.example/api/srb/webhook",
      direction: "outbound",
      sharedSecretId: "secret-2",
      createdBy: "user-1",
      createdAt: new Date(),
    };
    mocks.route.mockResolvedValue({ path: "webhook", linkId: link.id, ...link });
    mocks.resolveSecretValue.mockResolvedValue("super-secret");
    mocks.insertSrbDeliveryLog.mockResolvedValue({ id: "delivery-2" });
    mocks.updateSrbDeliveryLog.mockResolvedValue(undefined);
    mocks.sendSrbWebhookRequest.mockResolvedValue({ ok: false, status: 503 });

    const dispatch = createWebhookDispatch({} as Db);
    const result = await dispatch.dispatch({
      linkId: link.id,
      event: "issue.updated",
      payload: { status: "blocked" },
      timestamp: 1743550000,
      idempotencyKey: "nonce-2",
    });

    expect(result.path).toBe("webhook");
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(503);
    expect(result.nextRetryAt).toBeInstanceOf(Date);
    expect(mocks.updateSrbDeliveryLog).toHaveBeenCalledWith(expect.anything(), "delivery-2", expect.objectContaining({
      status: "failed",
      attemptCount: 1,
      nextRetryAt: expect.any(Date),
    }));
    expect(mocks.recordSrbFailure).toHaveBeenCalledTimes(1);
  });

  it("local dispatch reuses inbound persistence without HMAC", async () => {
    const link = {
      id: "link-local",
      localCompanyId: "company-source",
      remoteCompanyId: "company-target",
      remoteServerUrl: null,
      direction: "outbound",
      sharedSecretId: null,
      createdBy: "user-1",
      createdAt: new Date(),
    };
    mocks.route.mockResolvedValue({ path: "local", linkId: link.id, ...link });
    mocks.inboundReceive.mockResolvedValue({
      deliveryId: "delivery-local",
      issueId: "issue-1",
      issueIdentifier: "OPS-41",
      status: "received",
    });

    const tx = {};

    const db = {
      transaction: vi.fn(async (cb: (txArg: Db) => Promise<unknown>) => await cb(tx as unknown as Db)),
    } as unknown as Db;

    const dispatch = createLocalDispatch(db);
    const result = await dispatch.dispatch({
      linkId: link.id,
      event: "issue.created",
      payload: { title: "Need help", description: "Please investigate" },
      timestamp: 1743550000,
      idempotencyKey: "nonce-local",
    });

    expect(result).toEqual({
      path: "local",
      deliveryId: "delivery-local",
      issueId: "issue-1",
      issueIdentifier: "OPS-41",
      status: "received",
    });
    expect(mocks.inboundReceive).toHaveBeenCalledWith(tx, expect.objectContaining({
      linkId: link.id,
      targetCompanyId: link.remoteCompanyId,
      event: "issue.created",
      payload: { title: "Need help", description: "Please investigate" },
      idempotencyKey: "nonce-local",
    }));
  });

  it("retry worker replays stored payload with SRB headers", async () => {
    const row = {
      id: "delivery-retry-1",
      linkId: "link-retry",
      event: "issue.updated",
      payloadHash: "hash-1",
      payloadJson: { title: "Retry me", priority: "high" },
      idempotencyKey: "nonce-retry-1",
      status: "failed",
      attemptCount: 1,
      lastAttemptAt: null,
      nextRetryAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const link = {
      id: "link-retry",
      localCompanyId: "company-local",
      remoteCompanyId: "company-remote",
      remoteServerUrl: "https://remote.example/api/srb/webhook",
      direction: "outbound",
      sharedSecretId: "secret-3",
      createdBy: "user-1",
      createdAt: new Date(),
    };

    mocks.resolveSecretValue.mockResolvedValue("super-secret");
    mocks.sendSrbWebhookRequest.mockResolvedValue({ ok: true, status: 200 });

    const selectMock = vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (table === srbLinks ? [link] : [row])),
        })),
      })),
    }));
    const setCalls: Record<string, unknown>[] = [];
    const updateMock = createRetryUpdateMock({ claimRows: [{ id: row.id }], setCalls });

    const db = {
      select: selectMock,
      update: updateMock,
    } as unknown as Db;

    const worker = createDeliveryRetryWorker(db);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();

    expect(mocks.sendSrbWebhookRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: link.remoteServerUrl,
      body: JSON.stringify({ event: "issue.updated", payload: { title: "Retry me", priority: "high" } }),
      headers: expect.objectContaining({
        "X-SRB-Link-Id": link.id,
        "X-SRB-Idempotency-Key": "nonce-retry-1",
      }),
    }));
  });

  it("retry worker skips delivery when another worker already claimed the row", async () => {
    const row = {
      id: "delivery-retry-claim",
      linkId: "link-retry-claim",
      event: "issue.updated",
      payloadHash: "hash-2",
      payloadJson: { title: "Claim me" },
      idempotencyKey: "nonce-claim",
      status: "failed",
      attemptCount: 1,
      lastAttemptAt: null,
      nextRetryAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [row]),
        })),
      })),
    }));
    const setCalls: Record<string, unknown>[] = [];
    const updateMock = createRetryUpdateMock({ claimRows: [], setCalls });

    const db = {
      select: selectMock,
      update: updateMock,
    } as unknown as Db;

    const worker = createDeliveryRetryWorker(db);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();

    expect(mocks.sendSrbWebhookRequest).not.toHaveBeenCalled();
  });

  it("retry worker reclaims stale retrying rows", async () => {
    const row = {
      id: "delivery-retry-stale",
      linkId: "link-retry-stale",
      event: "issue.updated",
      payloadHash: "hash-stale",
      payloadJson: { title: "Recover me" },
      idempotencyKey: "nonce-stale",
      status: "retrying",
      attemptCount: 1,
      lastAttemptAt: null,
      nextRetryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 5 * 60_000),
    };
    const link = {
      id: "link-retry-stale",
      localCompanyId: "company-local",
      remoteCompanyId: "company-remote",
      remoteServerUrl: "https://remote.example/api/srb/webhook",
      direction: "outbound",
      sharedSecretId: "secret-stale",
      createdBy: "user-1",
      createdAt: new Date(),
    };

    mocks.resolveSecretValue.mockResolvedValue("super-secret");
    mocks.sendSrbWebhookRequest.mockResolvedValue({ ok: true, status: 200 });

    const selectMock = vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (table === srbLinks ? [link] : [row])),
        })),
      })),
    }));
    const setCalls: Record<string, unknown>[] = [];
    const updateMock = createRetryUpdateMock({ claimRows: [{ id: row.id }], setCalls });

    const db = {
      select: selectMock,
      update: updateMock,
    } as unknown as Db;

    const worker = createDeliveryRetryWorker(db);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();

    expect(mocks.sendSrbWebhookRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({
        "X-SRB-Idempotency-Key": "nonce-stale",
      }),
    }));
  });

  it("retry worker does not reclaim fresh retrying rows", async () => {
    const row = {
      id: "delivery-retry-fresh",
      linkId: "link-retry-fresh",
      event: "issue.updated",
      payloadHash: "hash-fresh",
      payloadJson: { title: "Still running" },
      idempotencyKey: "nonce-fresh",
      status: "retrying",
      attemptCount: 1,
      lastAttemptAt: null,
      nextRetryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const selectMock = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    }));
    const setCalls: Record<string, unknown>[] = [];
    const updateMock = createRetryUpdateMock({ claimRows: [], setCalls });

    const db = {
      select: selectMock,
      update: updateMock,
    } as unknown as Db;

    const worker = createDeliveryRetryWorker(db);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();

    expect(mocks.sendSrbWebhookRequest).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it("retry worker abandons legacy rows without replay payload", async () => {
    const row = {
      id: "delivery-retry-legacy",
      linkId: "link-retry-legacy",
      event: "issue.updated",
      payloadHash: "hash-legacy",
      payloadJson: null,
      idempotencyKey: null,
      status: "failed",
      attemptCount: 2,
      lastAttemptAt: null,
      nextRetryAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const link = {
      id: "link-retry-legacy",
      localCompanyId: "company-local",
      remoteCompanyId: "company-remote",
      remoteServerUrl: "https://remote.example/api/srb/webhook",
      direction: "outbound",
      sharedSecretId: "secret-legacy",
      createdBy: "user-1",
      createdAt: new Date(),
    };

    const setCalls: Record<string, unknown>[] = [];
    const updateMock = createRetryUpdateMock({ claimRows: [{ id: row.id }], setCalls });
    const selectMock = vi.fn(() => ({
      from: vi.fn((table) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (table === srbLinks ? [link] : [row])),
        })),
      })),
    }));

    const db = {
      select: selectMock,
      update: updateMock,
    } as unknown as Db;

    const worker = createDeliveryRetryWorker(db);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.stop();

    expect(mocks.sendSrbWebhookRequest).not.toHaveBeenCalled();
    expect(setCalls.some((call) => call.status === "abandoned")).toBe(true);
  });
});
