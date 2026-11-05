import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeliveryRetryWorker } from "../services/srb/delivery-retry-worker.js";
import { createNonceCleanupJob, cleanupExpiredNonces } from "../services/srb/nonce-cleanup.js";
import { createAuditLogCleanupJob, runAuditLogCleanup } from "../services/audit-log-cleanup.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const fakes = vi.hoisted(() => ({
  schema: {
    srbDeliveryLog: { id: "delivery.id", linkId: "delivery.linkId", event: "delivery.event", payloadHash: "delivery.payloadHash", payloadJson: "delivery.payloadJson", idempotencyKey: "delivery.idempotencyKey", status: "delivery.status", attemptCount: "delivery.attemptCount", lastAttemptAt: "delivery.lastAttemptAt", nextRetryAt: "delivery.nextRetryAt", updatedAt: "delivery.updatedAt", createdAt: "delivery.createdAt" },
    srbLinks: { id: "link.id", localCompanyId: "link.localCompanyId", remoteServerUrl: "link.remoteServerUrl", sharedSecretId: "link.sharedSecretId" },
    srbNonces: { idempotencyKey: "nonce.idempotencyKey", receivedAt: "nonce.receivedAt" },
    worktreeAuditLog: { id: "worktree.id", createdAt: "worktree.createdAt" },
    toolAuditLog: { id: "tool.id", createdAt: "tool.createdAt" },
  },
  drizzle: {
    eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
    isNull: (column: unknown) => ({ op: "isNull", column }),
    lt: (column: unknown, value: unknown) => ({ op: "lt", column, value }),
    lte: (column: unknown, value: unknown) => ({ op: "lte", column, value }),
    inArray: (column: unknown, value: unknown) => ({ op: "inArray", column, value }),
    and: (...conditions: unknown[]) => ({ op: "and", conditions }),
    or: (...conditions: unknown[]) => ({ op: "or", conditions }),
    asc: (column: unknown) => ({ op: "asc", column }),
    desc: (column: unknown) => ({ op: "desc", column }),
  },
  resolveSecretValue: vi.fn(),
  send: vi.fn(),
  retryMetric: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@paperclipai/db", () => fakes.schema);
vi.mock("drizzle-orm", () => fakes.drizzle);
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ resolveSecretValue: fakes.resolveSecretValue }) }));
vi.mock("../services/srb/shared.js", async () => {
  const actual = await vi.importActual<typeof import("../services/srb/shared.js")>("../services/srb/shared.js");
  return { ...actual, sendSrbWebhookRequest: fakes.send };
});
vi.mock("../routes/metrics.js", () => ({ srbRetryTransitions: { inc: fakes.retryMetric } }));
vi.mock("../middleware/logger.js", () => ({ logger: { info: fakes.logInfo, warn: fakes.logWarn, error: fakes.logError } }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function captureInterval() {
  let callback: (() => void) | undefined;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: TimerHandler) => {
    callback = fn as () => void;
    return 71 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
  return () => callback;
}

const originalDelivery = {
  id: "delivery-1", linkId: "link-1", event: "issue.updated", payloadHash: "hash-1",
  payloadJson: { title: "preserve me" }, idempotencyKey: "key-1", status: "failed",
  attemptCount: 4, lastAttemptAt: new Date("2026-10-29T00:00:00Z"),
  nextRetryAt: new Date("2026-10-28T23:00:00Z"), createdAt: new Date("2026-10-28T00:00:00Z"),
  updatedAt: new Date("2026-10-28T23:30:00Z"),
};
const link = { id: "link-1", localCompanyId: "company-1", remoteServerUrl: "https://remote.test/hook", sharedSecretId: "secret-1" };

function deliveryDb(options: {
  due?: typeof originalDelivery[];
  linkRows?: typeof link[];
  finishGate?: Promise<void>;
  finishEntered?: { resolve: () => void };
  finishError?: Error;
  restoreError?: Error;
} = {}) {
  const updates: Array<{ values: Record<string, unknown>; predicate: unknown }> = [];
  const selects = vi.fn(() => ({ from: (table: unknown) => ({ where: () => ({
    orderBy: () => ({ limit: async () => table === fakes.schema.srbLinks ? (options.linkRows ?? [link]) : (options.due ?? [originalDelivery]) }),
    limit: async () => table === fakes.schema.srbLinks ? (options.linkRows ?? [link]) : (options.due ?? [originalDelivery]),
  }) }) }));
  const update = vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: (predicate: unknown) => {
    updates.push({ values, predicate });
    if (values.status === "retrying") {
      return { returning: async () => [{ id: originalDelivery.id }] };
    }
    let completion: Promise<void> = Promise.resolve();
    if (values.status === "delivered" && options.finishGate) completion = options.finishGate;
    else if (values.status === "delivered" && options.finishError) completion = Promise.reject(options.finishError);
    else if (values.status === originalDelivery.status && options.restoreError) completion = Promise.reject(options.restoreError);
    if (values.status === "delivered") options.finishEntered?.resolve();
    return { then: (resolve: (value: undefined) => unknown, reject: (error: unknown) => unknown) => completion.then(resolve, reject) };
  } }) }));
  return { db: { select: selects, update } as unknown as Db, updates, selects };
}

function cleanupDb(entered: { resolve: () => void }, held: Promise<void>) {
  let first = true;
  const deletes = vi.fn(() => ({ where: () => ({ returning: async () => {
    if (first) { first = false; entered.resolve(); await held; }
    return [{ id: "deleted" }];
  } }) }));
  return { db: { delete: deletes } as unknown as Db, deletes };
}

describe("maintenance owner drains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.resolveSecretValue.mockResolvedValue("secret-value");
    fakes.send.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("blocks a prepared SRB send at shutdown and restores the exact unsent claim", async () => {
    const interval = captureInterval();
    const secretEntered = deferred(); const secretGate = deferred<string>();
    fakes.resolveSecretValue.mockImplementation(() => { secretEntered.resolve(); return secretGate.promise; });
    const { db, updates, selects } = deliveryDb();
    const lifecycle = createRuntimeExecutionLifecycle();
    const worker = createDeliveryRetryWorker(db, lifecycle);
    worker.start();
    await flushMicrotasks();
    expect(fakes.resolveSecretValue).toHaveBeenCalledTimes(1);
    await secretEntered.promise;

    lifecycle.beginShutdown("SIGTERM");
    worker.stop();
    const drain = worker.drain(); await expectPending(drain);
    const selectCount = selects.mock.calls.length;
    interval()?.();
    await Promise.resolve();
    expect(selects).toHaveBeenCalledTimes(selectCount);

    secretGate.resolve("secret-value");
    await flushMicrotasks();
    expect(updates).toHaveLength(2);
    await drain;
    expect(fakes.send).not.toHaveBeenCalled();
    expect(worker.getState().totalAttempts).toBe(0);
    expect(fakes.retryMetric).not.toHaveBeenCalled();
    expect(updates.map(({ values }) => values)).toEqual([
      expect.objectContaining({ status: "retrying" }),
      { status: originalDelivery.status, updatedAt: originalDelivery.updatedAt },
    ]);
    const restoreWhere = updates[1]!.predicate as { op: string; conditions: Array<{ column: unknown; value?: unknown }> };
    expect(restoreWhere.op).toBe("and");
    expect(restoreWhere.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: fakes.schema.srbDeliveryLog.id, value: originalDelivery.id }),
      expect.objectContaining({ column: fakes.schema.srbDeliveryLog.status, value: "retrying" }),
      expect.objectContaining({ column: fakes.schema.srbDeliveryLog.linkId, value: originalDelivery.linkId }),
      expect.objectContaining({ column: fakes.schema.srbDeliveryLog.payloadHash, value: originalDelivery.payloadHash }),
      expect.objectContaining({ column: fakes.schema.srbDeliveryLog.attemptCount, value: originalDelivery.attemptCount }),
    ]));
    expect(updates[1]!.values).not.toHaveProperty("attemptCount");
    expect(updates[1]!.values).not.toHaveProperty("nextRetryAt");
    expect(updates[1]!.values).not.toHaveProperty("lastAttemptAt");
    worker.stop();
  });

  it("drains an already-sent SRB response and its durable finalization exactly once", async () => {
    captureInterval();
    const sent = deferred(); const responseGate = deferred<{ ok: boolean; status: number }>();
    const finalizationEntered = deferred(); const finalizationGate = deferred();
    fakes.send.mockImplementation(() => { sent.resolve(); return responseGate.promise; });
    const { db, updates } = deliveryDb({ finishGate: finalizationGate.promise, finishEntered: finalizationEntered });
    const lifecycle = createRuntimeExecutionLifecycle();
    const worker = createDeliveryRetryWorker(db, lifecycle);
    worker.start(); await sent.promise;
    lifecycle.beginShutdown("SIGTERM"); worker.stop();
    const drain = worker.drain(); await expectPending(drain);

    responseGate.resolve({ ok: true, status: 200 });
    await finalizationEntered.promise;
    await expectPending(drain);
    finalizationGate.resolve();
    await drain;
    expect(fakes.send).toHaveBeenCalledTimes(1);
    expect(updates.filter(({ values }) => values.status === "delivered")).toHaveLength(1);
    expect(updates.find(({ values }) => values.status === "delivered")!.values).toMatchObject({
      status: "delivered", attemptCount: originalDelivery.attemptCount + 1, nextRetryAt: null,
    });
    expect(worker.getState()).toMatchObject({ totalAttempts: 1, totalDelivered: 1 });
  });

  it.each(["finalization", "restore"] as const)("retains a rejected SRB %s operation for drain", async (stage) => {
    captureInterval();
    const failure = new Error(`${stage} failed`);
    const lifecycle = createRuntimeExecutionLifecycle();
    let options: NonNullable<Parameters<typeof deliveryDb>[0]> = {};
    if (stage === "finalization") options.finishError = failure;
    else options.restoreError = failure;
    const { db } = deliveryDb(options);
    const worker = createDeliveryRetryWorker(db, lifecycle);

    if (stage === "finalization") {
      const sent = deferred();
      fakes.send.mockImplementation(() => { sent.resolve(); return Promise.resolve({ ok: true, status: 200 }); });
      worker.start(); await sent.promise;
      lifecycle.beginShutdown("SIGTERM"); worker.stop();
      await flushMicrotasks();
      expect(fakes.logError).toHaveBeenCalledTimes(1);
      await expect(worker.drain()).rejects.toBe(failure);
      expect(fakes.send).toHaveBeenCalledTimes(1);
    } else {
      const secretEntered = deferred(); const secretGate = deferred<string>();
      fakes.resolveSecretValue.mockImplementation(() => { secretEntered.resolve(); return secretGate.promise; });
      worker.start(); await secretEntered.promise;
      lifecycle.beginShutdown("SIGTERM"); worker.stop();
      const drain = worker.drain(); await expectPending(drain);
      secretGate.resolve("secret-value");
      await expect(drain).rejects.toBe(failure);
      expect(fakes.send).not.toHaveBeenCalled();
      expect(fakes.logError).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["nonce", "audit"] as const)("drains %s cleanup DB work and preserves its manual function", async (kind) => {
    const interval = captureInterval();
    const entered = deferred(); const gate = deferred();
    const { db, deletes } = cleanupDb(entered, gate.promise);
    const job = kind === "nonce" ? createNonceCleanupJob(db) : createAuditLogCleanupJob(db);
    job.start(); await entered.promise;
    job.stop();
    const drain = job.drain(); await expectPending(drain);
    const deleteCount = deletes.mock.calls.length;
    interval()?.(); await Promise.resolve();
    expect(deletes).toHaveBeenCalledTimes(deleteCount);
    gate.resolve(); await drain;

    if (kind === "nonce") expect(await cleanupExpiredNonces(db)).toBe(1);
    else expect(await runAuditLogCleanup(db)).toEqual({ worktreeAuditLogDeleted: 1, toolAuditLogDeleted: 1, srbDeliveryLogDeleted: 1 });
  });

  it("keeps audit drain pending after one delete rejects until its sibling settles", async () => {
    captureInterval();
    const siblingEntered = deferred(); const siblingGate = deferred(); const rejected = deferred();
    const failure = new Error("tool audit delete failed");
    const db = {
      delete: (table: unknown) => ({ where: () => ({ returning: async () => {
        if (table === fakes.schema.worktreeAuditLog) { siblingEntered.resolve(); await siblingGate.promise; return [{ id: "worktree" }]; }
        if (table === fakes.schema.toolAuditLog) { rejected.resolve(); throw failure; }
        return [{ id: "srb" }];
      } }) }),
    } as unknown as Db;
    const job = createAuditLogCleanupJob(db);
    job.start(); await Promise.all([siblingEntered.promise, rejected.promise]);
    job.stop();
    const drain = job.drain(); await expectPending(drain);
    expect(fakes.logError).not.toHaveBeenCalled();
    siblingGate.resolve(); await drain;
    expect(fakes.logError).toHaveBeenCalledWith({ err: failure }, "Audit log cleanup: failed");
  });
});
