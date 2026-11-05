import { isDeepStrictEqual } from "node:util";
import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { pluginToolExecutionReceipts } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import type { ToolOutcome } from "./plugin-job-rpc.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ActualToolOutcome = Exclude<ToolOutcome, { kind: "unknown" }>;

const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json),
]));
const nonempty = z.string().min(1);
const workflowSchema = z.object({
  missionId: nonempty.nullable(),
  workflowRunId: nonempty,
  stepRunId: nonempty,
  stepId: nonempty,
  requestId: nonempty,
  executionGeneration: z.number().int().nonnegative().safe(),
  statusTransitionVersion: z.number().int().nonnegative().safe(),
  runStatus: z.literal("running"),
  stepStatus: z.literal("running"),
  acceptedAt: z.string().datetime({ offset: true }),
}).strict();

export type OriginalWorkflowAuthority = z.infer<typeof workflowSchema>;

const requestSchema = z.object({
  kind: z.literal("paperclip.retained-tool-request"),
  version: z.literal(1),
  receiptId: z.string().uuid(),
  consumer: z.enum(["workflow", "http-keyed", "http-internal"]),
  companyId: z.string().uuid(),
  tool: nonempty,
  parameters: json,
  identity: z.object({ runId: nonempty, idempotencyKey: nonempty.max(200) }).strict(),
  workflow: workflowSchema.optional(),
}).strict().refine((request) => request.consumer !== "workflow" || request.workflow !== undefined);

export type RetainedToolRequest = z.infer<typeof requestSchema>;

const rpcId = z.union([z.string(), z.number().finite()]);
const rpcError = z.object({ code: z.number().int(), message: z.string(), data: json.optional() }).passthrough();
const toolResult = z.object({ content: z.string().optional(), data: json.optional(), error: z.string().optional() }).passthrough();
const actualSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("result"), result: json,
    response: z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: json }).passthrough(),
  }).strict(),
  z.object({
    kind: z.literal("error"), error: rpcError,
    response: z.object({ jsonrpc: z.literal("2.0"), id: rpcId.nullable(), error: rpcError }).passthrough(),
  }).strict(),
]).refine((actual) => actual.kind === "result"
  ? !("error" in actual.response) && jsonEqual(actual.result, actual.response.result)
  : !("result" in actual.response) && jsonEqual(actual.error, actual.response.error));

const responseSchema = z.object({ status: z.number().int().min(100).max(599), body: json }).strict();
const dispositionSchema = z.object({
  kind: z.enum(["applied", "superseded"]),
  reason: z.string().regex(/^[a-z][a-z0-9_]*$/),
  workflow: workflowSchema,
}).strict();
const outcomeSchema = z.object({
  kind: z.literal("paperclip.retained-tool-outcome"),
  version: z.literal(1),
  receiptId: z.string().uuid(),
  actual: actualSchema,
  response: responseSchema.optional(),
  disposition: dispositionSchema.optional(),
}).strict();

export type RetainedResponse = z.infer<typeof responseSchema>;
export type RetainedDisposition = z.infer<typeof dispositionSchema>;
export type RetainedToolOutcome = Omit<z.infer<typeof outcomeSchema>, "actual"> & { actual: unknown };

export class ToolReceiptPersistenceError extends Error {
  constructor(readonly code: "invalid" | "missing" | "owner" | "conflict" | "write" | "collision") {
    super(`Tool receipt persistence: ${code}`);
    this.name = "ToolReceiptPersistenceError";
  }
}

/** Compare persisted JSON values without depending on JSON object key order. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (!json.safeParse(left).success || !json.safeParse(right).success) return false;
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

export function validRequest(value: unknown): value is RetainedToolRequest {
  return json.safeParse(value).success && requestSchema.safeParse(value).success;
}

function validObservedActual(value: unknown): boolean {
  return json.safeParse(value).success && actualSchema.safeParse(value).success;
}

/** A stored worker response may be real but malformed; only this decoder grants ToolOutcome shape. */
export function decodeRetainedToolActual(value: unknown): ActualToolOutcome | null {
  const parsed = actualSchema.safeParse(value);
  if (!json.safeParse(value).success || !parsed.success) return null;
  if (parsed.data.kind === "result" && !toolResult.safeParse(parsed.data.result).success) return null;
  return value as ActualToolOutcome;
}

export function validOutcome(value: unknown): value is RetainedToolOutcome {
  return json.safeParse(value).success && outcomeSchema.safeParse(value).success;
}

const payloadEncoding = "json-string-v1";

/** JSON text keeps every JSON value representable inside PostgreSQL jsonb, including NUL. */
export function encodeRetainedToolRequest(request: RetainedToolRequest): unknown {
  return { ...request, parameters: JSON.stringify(request.parameters), payloadEncoding };
}

function encodeRetainedToolOutcome(outcome: RetainedToolOutcome): unknown {
  return {
    ...outcome, actual: JSON.stringify(outcome.actual), payloadEncoding,
    ...(outcome.response ? { response: { ...outcome.response, body: JSON.stringify(outcome.response.body) } } : {}),
  };
}

/** Decode the storage representation before exposing or comparing the original JSON values. */
export function decodeRetainedToolOutcome(value: unknown): RetainedToolOutcome | null {
  const storage = z.object({
    payloadEncoding: z.literal(payloadEncoding), actual: z.string(),
    response: z.object({ status: z.number(), body: z.string() }).strict().optional(),
  }).passthrough().safeParse(value);
  if (!storage.success) return null;
  try {
    const { payloadEncoding: _encoding, actual, response, ...rest } = storage.data;
    const decoded = {
      ...rest, actual: JSON.parse(actual),
      ...(response ? { response: { status: response.status, body: JSON.parse(response.body) } } : {}),
    };
    return validOutcome(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function validFinal(value: unknown): value is { response?: RetainedResponse; disposition?: RetainedDisposition } {
  return json.safeParse(value).success && z.object({
    response: responseSchema.optional(), disposition: dispositionSchema.optional(),
  }).strict().safeParse(value).success;
}

/** A tag alone is never sufficient: the envelope must match every immutable row identity field. */
export function requestForRow(row: {
  id: string; companyId: string; runId: string; tool: string; idempotencyKey: string; requestParameters: unknown;
}): RetainedToolRequest | null {
  const storage = z.object({ payloadEncoding: z.literal(payloadEncoding), parameters: z.string() })
    .passthrough().safeParse(row.requestParameters);
  if (!storage.success) return null;
  let request: unknown;
  try {
    const { payloadEncoding: _encoding, parameters, ...rest } = storage.data;
    request = { ...rest, parameters: JSON.parse(parameters) };
  } catch {
    return null;
  }
  if (!validRequest(request) || request.receiptId !== row.id || request.companyId !== row.companyId ||
      request.tool !== row.tool || request.identity.runId !== row.runId ||
      request.identity.idempotencyKey !== row.idempotencyKey) return null;
  return request;
}

type ReceiptTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ReceiptDb = Db | ReceiptTransaction;
type ReceiptRow = typeof pluginToolExecutionReceipts.$inferSelect;

async function lockedOwner(db: ReceiptTransaction, owner: RetainedToolRequest): Promise<ReceiptRow> {
  if (!validRequest(owner)) throw new ToolReceiptPersistenceError("invalid");
  const [row] = await db.select().from(pluginToolExecutionReceipts)
    .where(eq(pluginToolExecutionReceipts.id, owner.receiptId)).for("update");
  if (!row) throw new ToolReceiptPersistenceError("missing");
  const request = requestForRow(row);
  if (!request || !jsonEqual(request, owner)) throw new ToolReceiptPersistenceError("owner");
  return row;
}

function stagedOutcome(row: ReceiptRow, owner: RetainedToolRequest): RetainedToolOutcome {
  const outcome = decodeRetainedToolOutcome(row.resultBody);
  if (!outcome || outcome.receiptId !== owner.receiptId || outcome.response || outcome.disposition ||
      row.resultStatus !== null || row.completedAt !== null) throw new ToolReceiptPersistenceError("conflict");
  return outcome;
}

/** Persist the complete worker result separately, before any workflow acceptance transaction. */
export async function stageRetainedToolOutcome(
  db: Db, owner: RetainedToolRequest, actual: ToolOutcome,
): Promise<void> {
  if (is(db, PgTransaction)) throw new ToolReceiptPersistenceError("invalid");
  if (!validObservedActual(actual)) throw new ToolReceiptPersistenceError("invalid");
  await db.transaction(async (tx) => {
    const row = await lockedOwner(tx, owner);
    if (row.status !== "executing") throw new ToolReceiptPersistenceError("conflict");
    if (row.resultBody !== null) {
      if (!jsonEqual(stagedOutcome(row, owner).actual, actual)) throw new ToolReceiptPersistenceError("conflict");
      return;
    }
    if (row.resultStatus !== null || row.completedAt !== null) throw new ToolReceiptPersistenceError("conflict");
    const envelope: RetainedToolOutcome = {
      kind: "paperclip.retained-tool-outcome", version: 1, receiptId: owner.receiptId, actual,
    };
    const [written] = await tx.update(pluginToolExecutionReceipts).set({ resultBody: encodeRetainedToolOutcome(envelope) })
      .where(and(eq(pluginToolExecutionReceipts.id, owner.receiptId), eq(pluginToolExecutionReceipts.status, "executing")))
      .returning();
    if (!written || !jsonEqual(requestForRow(written), owner) || !jsonEqual(decodeRetainedToolOutcome(written.resultBody), envelope) ||
        written.status !== "executing" || written.resultStatus !== null || written.completedAt !== null) {
      throw new ToolReceiptPersistenceError("write");
    }
  });
}

function completedMatches(row: ReceiptRow, owner: RetainedToolRequest, outcome: RetainedToolOutcome): boolean {
  return row.status === "completed" && row.completedAt !== null && jsonEqual(requestForRow(row), owner) &&
    row.resultStatus === (outcome.response?.status ?? null) && jsonEqual(decodeRetainedToolOutcome(row.resultBody), outcome) &&
    row.workflowRunId === (owner.workflow?.workflowRunId ?? null) && row.stepId === (owner.workflow?.stepId ?? null);
}

/** Complete under an optional caller transaction, requiring exact staged actual and final authority. */
export async function completeRetainedToolReceipt(
  db: ReceiptDb,
  owner: RetainedToolRequest,
  actual: ToolOutcome,
  final: { response?: RetainedResponse; disposition?: RetainedDisposition },
): Promise<void> {
  if (!validRequest(owner) || !decodeRetainedToolActual(actual) || !validFinal(final)) {
    throw new ToolReceiptPersistenceError("invalid");
  }
  if (owner.consumer === "workflow") {
    if (!final.disposition || !jsonEqual(final.disposition.workflow, owner.workflow)) throw new ToolReceiptPersistenceError("owner");
  } else if (!final.response || final.disposition) {
    throw new ToolReceiptPersistenceError("invalid");
  }
  const outcome: RetainedToolOutcome = {
    kind: "paperclip.retained-tool-outcome", version: 1, receiptId: owner.receiptId, actual, ...final,
  };
  if (!validOutcome(outcome)) throw new ToolReceiptPersistenceError("invalid");
  await db.transaction(async (tx) => {
    const row = await lockedOwner(tx, owner);
    if (row.status === "completed") {
      if (!completedMatches(row, owner, outcome)) throw new ToolReceiptPersistenceError("conflict");
      return;
    }
    if (!jsonEqual(stagedOutcome(row, owner).actual, actual)) throw new ToolReceiptPersistenceError("conflict");
    const [written] = await tx.update(pluginToolExecutionReceipts).set({
      status: "completed", resultStatus: final.response?.status ?? null,
      resultBody: encodeRetainedToolOutcome(outcome), completedAt: new Date(),
      workflowRunId: owner.workflow?.workflowRunId ?? null, stepId: owner.workflow?.stepId ?? null,
    }).where(and(eq(pluginToolExecutionReceipts.id, owner.receiptId), eq(pluginToolExecutionReceipts.status, "executing")))
      .returning();
    if (written && completedMatches(written, owner, outcome)) return;
    const [readback] = await tx.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
    if (!readback || !completedMatches(readback, owner, outcome)) throw new ToolReceiptPersistenceError("write");
  });
}
