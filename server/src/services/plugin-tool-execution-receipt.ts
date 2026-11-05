import { randomUUID } from "node:crypto";
import { and, eq, is, isNull, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { pluginToolExecutionReceipts } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  decodeRetainedToolOutcome, encodeRetainedToolRequest, jsonEqual, requestForRow, ToolReceiptPersistenceError, validRequest,
  type JsonValue, type OriginalWorkflowAuthority, type ReceiptDb, type RetainedToolRequest,
} from "./plugin-tool-receipt-envelope.js";
import type { ObservedToolExecution } from "./plugin-tool-observation.js";
import { TOOL_NAMESPACE_SEPARATOR } from "./plugin-tool-registry.js";
import { deferredBeforeStartSchema, runtimeExecutionIdentitySchema } from "./runtime-execution-lifecycle.js";
import { z } from "zod";

export {
  completeRetainedToolReceipt, decodeRetainedToolActual, decodeRetainedToolOutcome,
  stageRetainedToolOutcome, ToolReceiptPersistenceError,
} from "./plugin-tool-receipt-envelope.js";
export type {
  ActualToolOutcome, OriginalWorkflowAuthority, RetainedDisposition, RetainedResponse, RetainedToolRequest,
} from "./plugin-tool-receipt-envelope.js";

/** An executing receipt is held regardless of age: age is not proof of an unsent call. */
export const TOOL_EXECUTION_TAKEOVER_MS = 10 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const CLAIM_ATTEMPTS = 3;

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= IDEMPOTENCY_KEY_MAX_LENGTH ? trimmed : null;
}

export interface ClaimToolExecutionReceiptInput {
  companyId: string;
  runId: string;
  tool: string;
  idempotencyKey: string;
  parameters: unknown;
}

export type ToolExecutionReceiptDecision =
  | { kind: "claim"; receiptId: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in-progress" };

type ReceiptRow = typeof pluginToolExecutionReceipts.$inferSelect;
const identityColumns = [
  pluginToolExecutionReceipts.companyId,
  pluginToolExecutionReceipts.runId,
  pluginToolExecutionReceipts.tool,
  pluginToolExecutionReceipts.idempotencyKey,
];

function identityWhere(input: ClaimToolExecutionReceiptInput) {
  return and(
    eq(pluginToolExecutionReceipts.companyId, input.companyId),
    eq(pluginToolExecutionReceipts.runId, input.runId),
    eq(pluginToolExecutionReceipts.tool, input.tool),
    eq(pluginToolExecutionReceipts.idempotencyKey, input.idempotencyKey),
  );
}

function existingDecision(row: ReceiptRow): ToolExecutionReceiptDecision {
  const request = requestForRow(row);
  if (request) {
    if (request.consumer !== "http-keyed" || row.status !== "completed") return { kind: "in-progress" };
    const outcome = decodeRetainedToolOutcome(row.resultBody);
    if (!outcome || outcome.receiptId !== row.id || !outcome.response || outcome.disposition ||
        row.resultStatus !== outcome.response.status || row.completedAt === null ||
        row.workflowRunId !== (request.workflow?.workflowRunId ?? null) ||
        row.stepId !== (request.workflow?.stepId ?? null)) return { kind: "in-progress" };
    return { kind: "replay", status: outcome.response.status, body: outcome.response.body };
  }
  if (row.status === "completed") {
    return { kind: "replay", status: row.resultStatus ?? 500, body: row.resultBody ?? {} };
  }
  return { kind: "in-progress" };
}

/** Existing keyed callers retain their response shape; an existing executing row is never taken over. */
export async function claimToolExecutionReceipt(
  db: Db, input: ClaimToolExecutionReceiptInput,
): Promise<ToolExecutionReceiptDecision> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const [inserted] = await db.insert(pluginToolExecutionReceipts).values({
      companyId: input.companyId, runId: input.runId, tool: input.tool, idempotencyKey: input.idempotencyKey,
      status: "executing", requestParameters: input.parameters ?? {}, claimedAt: new Date(),
    }).onConflictDoNothing({ target: identityColumns }).returning({ id: pluginToolExecutionReceipts.id });
    if (inserted) return { kind: "claim", receiptId: inserted.id };
    const [existing] = await db.select().from(pluginToolExecutionReceipts).where(identityWhere(input));
    if (existing) return existingDecision(existing);
  }
  throw new ToolReceiptPersistenceError("collision");
}

/** Insert an internal identity; only HTTP callers may preserve their visible run id. */
export async function insertInternalToolReceipt(
  db: ReceiptDb,
  input: {
    companyId: string; tool: string; parameters: unknown; consumer: "workflow" | "http-internal";
    workflow?: OriginalWorkflowAuthority; httpRunId?: string;
  },
): Promise<RetainedToolRequest> {
  const hasHttpRunId = Object.prototype.hasOwnProperty.call(input, "httpRunId");
  if (hasHttpRunId && input.consumer !== "http-internal") throw new ToolReceiptPersistenceError("invalid");
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const owner: RetainedToolRequest = {
      kind: "paperclip.retained-tool-request", version: 1, receiptId: randomUUID(),
      consumer: input.consumer, companyId: input.companyId, tool: input.tool,
      parameters: (input.parameters === undefined ? {} : input.parameters) as JsonValue,
      identity: { runId: hasHttpRunId ? input.httpRunId! : randomUUID(), idempotencyKey: randomUUID() },
      ...(input.workflow ? { workflow: input.workflow } : {}),
    };
    if (!validRequest(owner)) throw new ToolReceiptPersistenceError("invalid");
    const [inserted] = await db.insert(pluginToolExecutionReceipts).values({
      id: owner.receiptId, companyId: owner.companyId, runId: owner.identity.runId, tool: owner.tool,
      idempotencyKey: owner.identity.idempotencyKey, status: "executing", requestParameters: encodeRetainedToolRequest(owner),
    }).onConflictDoNothing().returning();
    if (inserted && jsonEqual(requestForRow(inserted), owner) && inserted.status === "executing" &&
        inserted.resultBody === null && inserted.resultStatus === null && inserted.completedAt === null) return owner;
    if (inserted) throw new ToolReceiptPersistenceError("write");
  }
  throw new ToolReceiptPersistenceError("collision");
}

/** New keyed consumers insert their own envelope, but never adopt a caller-created row. */
export async function claimRetainedKeyedToolReceipt(
  db: ReceiptDb, input: ClaimToolExecutionReceiptInput,
): Promise<{ kind: "claim"; owner: RetainedToolRequest } | Exclude<ToolExecutionReceiptDecision, { kind: "claim" }>> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const owner: RetainedToolRequest = {
      kind: "paperclip.retained-tool-request", version: 1, receiptId: randomUUID(), consumer: "http-keyed",
      companyId: input.companyId, tool: input.tool,
      parameters: (input.parameters === undefined ? {} : input.parameters) as JsonValue,
      identity: { runId: input.runId, idempotencyKey: input.idempotencyKey },
    };
    if (!validRequest(owner)) throw new ToolReceiptPersistenceError("invalid");
    const [inserted] = await db.insert(pluginToolExecutionReceipts).values({
      id: owner.receiptId, companyId: owner.companyId, runId: owner.identity.runId, tool: owner.tool,
      idempotencyKey: owner.identity.idempotencyKey, status: "executing", requestParameters: encodeRetainedToolRequest(owner),
    }).onConflictDoNothing().returning();
    if (inserted && jsonEqual(requestForRow(inserted), owner) && inserted.status === "executing" &&
        inserted.resultBody === null && inserted.resultStatus === null && inserted.completedAt === null) {
      return { kind: "claim", owner };
    }
    if (inserted) throw new ToolReceiptPersistenceError("write");
    const [existing] = await db.select().from(pluginToolExecutionReceipts).where(identityWhere(input));
    if (existing) return existingDecision(existing) as Exclude<ToolExecutionReceiptDecision, { kind: "claim" }>;
  }
  throw new ToolReceiptPersistenceError("collision");
}

/** Complete a legacy receipt only after a verified update or identical completed readback. */
export async function completeToolExecutionReceipt(
  db: ReceiptDb,
  receiptId: string,
  result: { status: number; body: unknown; workflowRunId?: string | null; stepId?: string | null },
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(JSON.stringify(result.body ?? {}));
  } catch {
    throw new ToolReceiptPersistenceError("invalid");
  }
  const workflowRunId = result.workflowRunId ?? null;
  const stepId = result.stepId ?? null;
  const matches = (row: ReceiptRow) => row.status === "completed" && row.completedAt !== null &&
    row.resultStatus === result.status && jsonEqual(row.resultBody, body) &&
    row.workflowRunId === workflowRunId && row.stepId === stepId && !requestForRow(row);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, receiptId)).for("update");
    if (!row) throw new ToolReceiptPersistenceError("missing");
    if (requestForRow(row)) throw new ToolReceiptPersistenceError("owner");
    if (row.status === "completed") {
      if (!matches(row)) throw new ToolReceiptPersistenceError("conflict");
      return;
    }
    const [written] = await tx.update(pluginToolExecutionReceipts).set({
      status: "completed", resultStatus: result.status, resultBody: body, completedAt: new Date(), workflowRunId, stepId,
    }).where(and(eq(pluginToolExecutionReceipts.id, receiptId), eq(pluginToolExecutionReceipts.status, "executing")))
      .returning();
    if (written && matches(written)) return;
    const [readback] = await tx.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, receiptId));
    if (!readback || !matches(readback)) throw new ToolReceiptPersistenceError("write");
  });
}

/** Legacy callers release their own definitely-unexecuted claim only. */
export async function releaseToolExecutionReceipt(db: Db, receiptId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(pluginToolExecutionReceipts)
      .where(eq(pluginToolExecutionReceipts.id, receiptId)).for("update");
    if (row && requestForRow(row)) throw new ToolReceiptPersistenceError("owner");
    await tx.delete(pluginToolExecutionReceipts).where(and(
      eq(pluginToolExecutionReceipts.id, receiptId), eq(pluginToolExecutionReceipts.status, "executing"),
    ));
  });
}

export type RetainedHttpUnsentRelease =
  | { kind: "released"; receiptId: string }
  | { kind: "held"; receiptId: string | null; reason: string };

const httpUnsentObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("definitely_unsent"), pluginId: z.string().min(1), toolName: z.string().min(1),
    identity: runtimeExecutionIdentitySchema,
  }).strict(),
  z.object({
    kind: z.literal("deferred_before_start"), pluginId: z.string().min(1), toolName: z.string().min(1),
    identity: runtimeExecutionIdentitySchema, deferredBeforeStart: deferredBeforeStartSchema,
  }).strict(),
]);

function heldHttpUnsent(owner: unknown, reason: string): RetainedHttpUnsentRelease {
  return { kind: "held", receiptId: validRequest(owner) ? owner.receiptId : null, reason };
}

function httpUnsentProofMatches(owner: RetainedToolRequest, observed: unknown): boolean {
  const parsed = httpUnsentObservationSchema.safeParse(observed);
  if (!parsed.success || (owner.consumer !== "http-keyed" && owner.consumer !== "http-internal") || owner.workflow) {
    return false;
  }
  const proof = parsed.data;
  const expected = {
    requestId: owner.receiptId,
    executionId: owner.identity.runId,
    attemptId: owner.receiptId,
    executionGeneration: 1,
  };
  if (`${proof.pluginId}${TOOL_NAMESPACE_SEPARATOR}${proof.toolName}` !== owner.tool ||
      !jsonEqual(proof.identity, expected)) return false;
  return proof.kind !== "deferred_before_start" || jsonEqual(proof.deferredBeforeStart, {
    kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down", externalStarted: false, ...expected,
  });
}

/** Delete only the exact HTTP receipt whose direct observation proves no worker send occurred. */
export async function releaseRetainedHttpToolUnsentReceipt(
  db: Db,
  owner: RetainedToolRequest,
  observed: ObservedToolExecution,
): Promise<RetainedHttpUnsentRelease> {
  if (is(db, PgTransaction)) throw new ToolReceiptPersistenceError("invalid");
  if (!validRequest(owner) || (owner.consumer !== "http-keyed" && owner.consumer !== "http-internal") || owner.workflow) {
    return heldHttpUnsent(owner, "owner_invalid");
  }
  if (!httpUnsentProofMatches(owner, observed)) return heldHttpUnsent(owner, "positive_unsent_proof_invalid");

  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      receipt: pluginToolExecutionReceipts,
      resultBodyIsSqlNull: sql<boolean>`${pluginToolExecutionReceipts.resultBody} IS NULL`,
    }).from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId)).for("update").limit(1);
    const encodedOwner = encodeRetainedToolRequest(owner);
    if (!row || !jsonEqual(requestForRow(row.receipt), owner) || row.receipt.status !== "executing" ||
        row.receipt.workflowRunId !== null || row.receipt.stepId !== null || !row.resultBodyIsSqlNull ||
        row.receipt.resultStatus !== null || row.receipt.completedAt !== null) {
      return heldHttpUnsent(owner, "receipt_missing_or_changed");
    }

    const removed = await tx.delete(pluginToolExecutionReceipts).where(and(
      eq(pluginToolExecutionReceipts.id, owner.receiptId),
      eq(pluginToolExecutionReceipts.companyId, owner.companyId),
      eq(pluginToolExecutionReceipts.runId, owner.identity.runId),
      eq(pluginToolExecutionReceipts.tool, owner.tool),
      eq(pluginToolExecutionReceipts.idempotencyKey, owner.identity.idempotencyKey),
      eq(pluginToolExecutionReceipts.requestParameters, encodedOwner),
      eq(pluginToolExecutionReceipts.status, "executing"),
      isNull(pluginToolExecutionReceipts.resultBody),
      isNull(pluginToolExecutionReceipts.resultStatus),
      isNull(pluginToolExecutionReceipts.completedAt),
      isNull(pluginToolExecutionReceipts.workflowRunId),
      isNull(pluginToolExecutionReceipts.stepId),
    )).returning({ id: pluginToolExecutionReceipts.id });
    if (removed.length !== 1 || removed[0]?.id !== owner.receiptId) {
      throw new ToolReceiptPersistenceError("write");
    }
    return { kind: "released", receiptId: owner.receiptId };
  });
}
