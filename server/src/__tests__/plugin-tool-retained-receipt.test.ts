import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, pluginToolExecutionReceipts, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimRetainedKeyedToolReceipt, claimToolExecutionReceipt, completeRetainedToolReceipt,
  completeToolExecutionReceipt, decodeRetainedToolActual, decodeRetainedToolOutcome, insertInternalToolReceipt,
  releaseRetainedHttpToolUnsentReceipt, releaseToolExecutionReceipt, stageRetainedToolOutcome,
  ToolReceiptPersistenceError, type OriginalWorkflowAuthority,
} from "../services/plugin-tool-execution-receipt.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const mockIds = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: () => mockIds.queue.shift() ?? original.randomUUID() };
});

const companyId = "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b001";
const workflow: OriginalWorkflowAuthority = {
  missionId: null, workflowRunId: "7b7d8a44-2f0f-4d92-9d92-6a83c0d1b002",
  stepRunId: "step-run", stepId: "step-1", requestId: "request-1", executionGeneration: 2,
  statusTransitionVersion: 3, runStatus: "running", stepStatus: "running", acceptedAt: "2026-10-29T00:00:00.000Z",
};
const result = { content: "complete", data: { nested: [1, { text: "full" }] } };
const actual: ToolOutcome = { kind: "result", result, response: { jsonrpc: "2.0", id: 7, result } };
const response = { status: 200, body: { content: "condensed" } };
const publicInput = { companyId, runId: "run-1", tool: "plugin:tool", idempotencyKey: "key-1", parameters: { q: 1 } };

describe("retained tool receipt persistence", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const rows = () => db.select().from(pluginToolExecutionReceipts);
  const internal = () => insertInternalToolReceipt(db, {
    companyId, tool: publicInput.tool, parameters: { q: 1 }, consumer: "http-internal",
  });
  const inputFor = (owner: Awaited<ReturnType<typeof internal>>) => ({
    companyId, tool: owner.tool, runId: owner.identity.runId,
    idempotencyKey: owner.identity.idempotencyKey, parameters: {},
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retained-receipt-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Retained receipt test" });
  }, 120_000);
  beforeEach(async () => {
    mockIds.queue.length = 0;
    await db.delete(pluginToolExecutionReceipts);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  it("releases an HTTP receipt only for the exact definitely-unsent observation", async () => {
    const owner = await internal();
    const identity = { requestId: owner.receiptId, executionId: owner.identity.runId,
      attemptId: owner.receiptId, executionGeneration: 1 };
    const proof = { kind: "definitely_unsent", pluginId: "plugin", toolName: "tool", identity } as const;
    expect((await releaseRetainedHttpToolUnsentReceipt(db, owner,
      { ...proof, identity: { ...identity, attemptId: randomUUID() } } as never)).kind).toBe("held");
    expect(await rows()).toHaveLength(1);
    expect((await releaseRetainedHttpToolUnsentReceipt(db, owner, proof as never)).kind).toBe("released");
    expect(await rows()).toHaveLength(0);
  });

  it("holds a receipt with a staged actual result even when an unsent claim is supplied", async () => {
    const owner = await internal();
    await stageRetainedToolOutcome(db, owner, actual);
    const identity = { requestId: owner.receiptId, executionId: owner.identity.runId,
      attemptId: owner.receiptId, executionGeneration: 1 };
    expect((await releaseRetainedHttpToolUnsentReceipt(db, owner,
      { kind: "definitely_unsent", pluginId: "plugin", toolName: "tool", identity } as never)).kind).toBe("held");
    expect(await rows()).toHaveLength(1);
  });

  it("retries a colliding internal tuple without adopting envelope-shaped legacy JSON", async () => {
    const legacyId = randomUUID();
    const fakeId = randomUUID();
    const legacyBody = { kind: "paperclip.retained-tool-outcome", version: 1, receiptId: fakeId, actual, response };
    await db.insert(pluginToolExecutionReceipts).values({
      id: legacyId, companyId, runId: "colliding-run", tool: publicInput.tool, idempotencyKey: "colliding-key",
      status: "completed", resultStatus: 207, resultBody: legacyBody, completedAt: new Date(),
      requestParameters: {
        kind: "paperclip.retained-tool-request", version: 1, receiptId: fakeId, consumer: "http-keyed",
        companyId, tool: publicInput.tool, parameters: "{}", payloadEncoding: "json-string-v1",
        identity: { runId: "colliding-run", idempotencyKey: "colliding-key" },
      },
    });
    mockIds.queue.push(randomUUID(), "colliding-run", "colliding-key", randomUUID(), "new-run", "new-key");
    const owner = await internal();
    expect(owner.identity).toEqual({ runId: "new-run", idempotencyKey: "new-key" });
    expect(await claimToolExecutionReceipt(db, { ...publicInput, runId: "colliding-run", idempotencyKey: "colliding-key" }))
      .toEqual({ kind: "replay", status: 207, body: legacyBody });
    expect(await claimRetainedKeyedToolReceipt(db, { ...publicInput, runId: "colliding-run", idempotencyKey: "colliding-key" }))
      .toEqual({ kind: "replay", status: 207, body: legacyBody });
    expect((await rows()).find((row) => row.id === legacyId)?.resultBody).toEqual(legacyBody);
    expect(await rows()).toHaveLength(2);
  });

  it("exhausts tuple collisions without granting a claim", async () => {
    await db.insert(pluginToolExecutionReceipts).values({
      companyId, runId: "same-run", tool: publicInput.tool, idempotencyKey: "same-key", status: "executing",
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) mockIds.queue.push(id, "same-run", "same-key");
    await expect(internal()).rejects.toMatchObject({ code: "collision" });
    expect(await rows()).toHaveLength(1);
  });

  it("keeps aged internal rows held and never exposes their completed response to a guessed tuple", async () => {
    const owner = await internal();
    const old = new Date("2020-01-01T00:00:00.000Z");
    await db.update(pluginToolExecutionReceipts).set({ claimedAt: old }).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
    const before = (await rows())[0];
    expect(await claimToolExecutionReceipt(db, inputFor(owner))).toEqual({ kind: "in-progress" });
    expect((await rows())[0]).toEqual(before);
    await expect(releaseToolExecutionReceipt(db, owner.receiptId)).rejects.toMatchObject({ code: "owner" });
    await stageRetainedToolOutcome(db, owner, actual);
    await completeRetainedToolReceipt(db, owner, actual, { response });
    expect(await claimToolExecutionReceipt(db, inputFor(owner))).toEqual({ kind: "in-progress" });
    expect(await claimRetainedKeyedToolReceipt(db, inputFor(owner))).toEqual({ kind: "in-progress" });
  });

  it("replays only a completed keyed server envelope and preserves the outward response", async () => {
    const claim = await claimRetainedKeyedToolReceipt(db, publicInput);
    if (claim.kind !== "claim") throw new Error("expected fresh claim");
    const old = new Date("2020-01-01T00:00:00.000Z");
    await db.update(pluginToolExecutionReceipts).set({ claimedAt: old }).where(eq(pluginToolExecutionReceipts.id, claim.owner.receiptId));
    expect(await claimToolExecutionReceipt(db, publicInput)).toEqual({ kind: "in-progress" });
    await stageRetainedToolOutcome(db, claim.owner, actual);
    await stageRetainedToolOutcome(db, claim.owner, actual);
    await completeRetainedToolReceipt(db, claim.owner, actual, { response });
    await completeRetainedToolReceipt(db, claim.owner, actual, { response });
    expect(await claimToolExecutionReceipt(db, publicInput)).toEqual({ kind: "replay", ...response });
    expect(await claimRetainedKeyedToolReceipt(db, publicInput)).toEqual({ kind: "replay", ...response });
    const [row] = await rows();
    expect(decodeRetainedToolOutcome(row.resultBody)).toMatchObject({ actual, response });
    expect(row.resultStatus).toBe(200);
  });

  it("round-trips NUL, literal backslashes, Unicode and object keys in retained JSON", async () => {
    const payload = { "key\u0000zero": "value\u0000x\\u0000한글🙂", "slash\\key": ["끝", "\\"] };
    const resultWithNul = { content: "worker\u0000result", data: payload };
    const observed: ToolOutcome = { kind: "result", result: resultWithNul, response: {
      jsonrpc: "2.0", id: 5, result: resultWithNul,
    } };
    const final = { status: 200, body: payload };
    const owner = await insertInternalToolReceipt(db, {
      companyId, tool: publicInput.tool, parameters: payload, consumer: "http-internal",
    });
    await stageRetainedToolOutcome(db, owner, observed);
    await stageRetainedToolOutcome(db, owner, observed);
    await completeRetainedToolReceipt(db, owner, observed, { response: final });
    expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual: observed, response: final });
    expect(await claimToolExecutionReceipt(db, inputFor(owner))).toEqual({ kind: "in-progress" });
    const claim = await claimRetainedKeyedToolReceipt(db, { ...publicInput, parameters: payload });
    if (claim.kind !== "claim") throw new Error("expected fresh keyed claim");
    expect(claim.owner.parameters).toEqual(payload);
    await stageRetainedToolOutcome(db, claim.owner, observed);
    await completeRetainedToolReceipt(db, claim.owner, observed, { response: final });
    expect(await claimToolExecutionReceipt(db, publicInput)).toEqual({ kind: "replay", ...final });
    const stored = (await rows()).find((row) => row.id === claim.owner.receiptId)!.resultBody as object;
    expect(decodeRetainedToolOutcome({ ...stored, actual: "{" })).toBeNull();
  });

  it.each([
    actual,
    { kind: "result", result: { error: "tool failure", data: { detail: 1 } }, response: {
      jsonrpc: "2.0", id: "tool", result: { error: "tool failure", data: { detail: 1 } },
    } },
    { kind: "error", error: { code: -32001, message: "rpc failure", data: { detail: [1, 2] } }, response: {
      jsonrpc: "2.0", id: 9, error: { code: -32001, message: "rpc failure", data: { detail: [1, 2] } },
    } },
    { kind: "error", error: { code: 1e20, message: "large integer code", data: { detail: true } }, response: {
      jsonrpc: "2.0", id: 1.5, error: { code: 1e20, message: "large integer code", data: { detail: true } },
    } },
  ] as ToolOutcome[])("stages a complete worker outcome independently of the HTTP body: $kind", async (outcome) => {
    const owner = await internal();
    await stageRetainedToolOutcome(db, owner, outcome);
    const [staged] = await rows();
    expect(staged.status).toBe("executing");
    expect(staged.resultStatus).toBeNull();
    expect(decodeRetainedToolOutcome(staged.resultBody)).toMatchObject({ actual: outcome });
    await completeRetainedToolReceipt(db, owner, outcome, { response });
    expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual: outcome, response });
  });

  it("treats reordered JSON object keys as the same staged actual", async () => {
    const owner = await internal();
    await stageRetainedToolOutcome(db, owner, actual);
    const reordered: ToolOutcome = { kind: "result", response: { result: {
      data: { nested: [1, { text: "full" }] }, content: "complete",
    }, id: 7, jsonrpc: "2.0" }, result: {
      data: { nested: [1, { text: "full" }] }, content: "complete",
    } };
    await stageRetainedToolOutcome(db, owner, reordered);
    await completeRetainedToolReceipt(db, owner, reordered, { response });
    expect((await rows())[0].status).toBe("completed");
  });

  it.each([null, "not a tool result", { content: 7 }])(
    "preserves malformed actual result %j without accepting it as a ToolResult", async (raw) => {
      const owner = await internal();
      const observed = { kind: "result", result: raw, response: { jsonrpc: "2.0", id: 7, result: raw } } as unknown as ToolOutcome;
      expect(decodeRetainedToolActual(observed)).toBeNull();
      expect(decodeRetainedToolActual(actual)).toEqual(actual);
      await stageRetainedToolOutcome(db, owner, observed);
      await stageRetainedToolOutcome(db, owner, observed);
      expect((await rows())[0].status).toBe("executing");
      expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual: observed });
      await expect(stageRetainedToolOutcome(db, owner, actual)).rejects.toMatchObject({ code: "conflict" });
      await expect(completeRetainedToolReceipt(db, owner, observed, { response })).rejects.toMatchObject({ code: "invalid" });
      expect((await rows())[0].status).toBe("executing");
      expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual: observed });
    },
  );

  it("rejects an inconsistent raw result and response without staging", async () => {
    const owner = await internal();
    const inconsistent = { kind: "result", result: null, response: { jsonrpc: "2.0", id: 7, result: "other" } } as unknown as ToolOutcome;
    await expect(stageRetainedToolOutcome(db, owner, inconsistent)).rejects.toMatchObject({ code: "invalid" });
    expect((await rows())[0].resultBody).toBeNull();
  });

  it("rejects unknown, mismatched outcomes, wrong owners, missing rows and conflicting completions", async () => {
    const owner = await internal();
    await expect(stageRetainedToolOutcome(db, owner, { kind: "unknown" })).rejects.toMatchObject({ code: "invalid" });
    await expect(completeRetainedToolReceipt(db, owner, actual, { response })).rejects.toMatchObject({ code: "conflict" });
    await stageRetainedToolOutcome(db, owner, actual);
    const other: ToolOutcome = { kind: "result", result: { content: "other" }, response: {
      jsonrpc: "2.0", id: 7, result: { content: "other" },
    } };
    await expect(stageRetainedToolOutcome(db, owner, other)).rejects.toMatchObject({ code: "conflict" });
    await expect(stageRetainedToolOutcome(db, { ...owner, tool: "wrong" }, actual)).rejects.toMatchObject({ code: "owner" });
    await expect(stageRetainedToolOutcome(db, { ...owner, receiptId: randomUUID() }, actual)).rejects.toMatchObject({ code: "missing" });
    await expect(completeRetainedToolReceipt(db, owner, other, { response })).rejects.toMatchObject({ code: "conflict" });
    await completeRetainedToolReceipt(db, owner, actual, { response });
    await expect(completeRetainedToolReceipt(db, owner, actual, { response: { status: 201, body: {} } }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(stageRetainedToolOutcome(db, owner, actual)).rejects.toMatchObject({ code: "conflict" });
  });

  it("completes workflow dispositions without inventing an HTTP status and rolls back atomically", async () => {
    const owner = await insertInternalToolReceipt(db, { companyId, tool: publicInput.tool, parameters: {}, consumer: "workflow", workflow });
    const disposition = { kind: "applied" as const, reason: "accepted", workflow };
    await stageRetainedToolOutcome(db, owner, actual);
    await expect(db.transaction(async (tx) => {
      await completeRetainedToolReceipt(tx, owner, actual, { disposition });
      throw new Error("rollback outer authority transaction");
    })).rejects.toThrow("rollback outer authority transaction");
    expect((await rows())[0]).toMatchObject({ status: "executing", resultStatus: null });
    expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual });
    await expect(completeRetainedToolReceipt(db, owner, actual, {
      disposition: { ...disposition, workflow: { ...workflow, executionGeneration: 3 } },
    })).rejects.toMatchObject({ code: "owner" });
    await completeRetainedToolReceipt(db, owner, actual, { disposition });
    await completeRetainedToolReceipt(db, owner, actual, { disposition });
    expect((await rows())[0]).toMatchObject({ status: "completed", resultStatus: null });
    expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual, disposition });
  });

  it("requires independent staging before entering a caller transaction", async () => {
    const owner = await internal();
    await expect(db.transaction((tx) => stageRetainedToolOutcome(tx as unknown as Db, owner, actual)))
      .rejects.toMatchObject({ code: "invalid" });
    expect((await rows())[0].resultBody).toBeNull();
    await stageRetainedToolOutcome(db, owner, actual);
    expect(decodeRetainedToolOutcome((await rows())[0].resultBody)).toMatchObject({ actual });
  });

  it("rejects forced zero-row writes and verifies legacy completed readback", async () => {
    const owner = await internal();
    const claim = await claimToolExecutionReceipt(db, publicInput);
    if (claim.kind !== "claim") throw new Error("expected legacy claim");
    await db.execute(sql`CREATE FUNCTION receipt_test_suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await db.execute(sql`CREATE TRIGGER receipt_test_suppress BEFORE UPDATE ON plugin_tool_execution_receipts FOR EACH ROW EXECUTE FUNCTION receipt_test_suppress_write()`);
    try {
      await expect(stageRetainedToolOutcome(db, owner, actual)).rejects.toMatchObject({ code: "write" });
      await expect(completeToolExecutionReceipt(db, claim.receiptId, response)).rejects.toMatchObject({ code: "write" });
    } finally {
      await db.execute(sql`DROP TRIGGER receipt_test_suppress ON plugin_tool_execution_receipts`);
      await db.execute(sql`DROP FUNCTION receipt_test_suppress_write()`);
    }
    await stageRetainedToolOutcome(db, owner, actual);
    await db.execute(sql`CREATE FUNCTION receipt_test_suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await db.execute(sql`CREATE TRIGGER receipt_test_suppress BEFORE UPDATE ON plugin_tool_execution_receipts FOR EACH ROW EXECUTE FUNCTION receipt_test_suppress_write()`);
    try {
      await expect(completeRetainedToolReceipt(db, owner, actual, { response })).rejects.toMatchObject({ code: "write" });
    } finally {
      await db.execute(sql`DROP TRIGGER receipt_test_suppress ON plugin_tool_execution_receipts`);
      await db.execute(sql`DROP FUNCTION receipt_test_suppress_write()`);
    }
    await completeToolExecutionReceipt(db, claim.receiptId, response);
    await completeToolExecutionReceipt(db, claim.receiptId, response);
    await expect(completeToolExecutionReceipt(db, claim.receiptId, { status: 500, body: {} }))
      .rejects.toBeInstanceOf(ToolReceiptPersistenceError);
    await expect(completeToolExecutionReceipt(db, randomUUID(), response)).rejects.toMatchObject({ code: "missing" });
    expect((await rows()).find((row) => row.id === owner.receiptId)?.status).toBe("executing");
  });
});
