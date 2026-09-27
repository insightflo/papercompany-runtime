import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { pluginWebhookDeliveries } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

/**
 * Inbound webhook receipt ingestion.
 *
 * One receipt row per (plugin, endpoint, external delivery id): the unique
 * index `plugin_webhook_deliveries_external_idx` makes the insert atomic, so
 * exactly one concurrent request wins the receipt and dispatches the worker.
 * Losers answer `duplicate` without a worker call. Failed receipts accept a
 * provider retry by reusing the row; abandoned `pending` receipts can be
 * taken over after {@link PENDING_TAKEOVER_MS} so a crashed dispatch never
 * silently swallows future retries (fail-closed).
 *
 * `externalId` extraction sources (PLUGIN_SPEC.md §21.3 does not define one):
 * header `x-delivery-id`, header `x-webhook-id`, then top-level payload
 * `deliveryId`. Payload `id` is deliberately NOT used: some providers (e.g.
 * Shopify) keep a constant object id across distinct deliveries, and a
 * false-positive match drops real deliveries — the failure mode this guard
 * exists to prevent. When no source yields an identifier, `external_id`
 * stays null and Postgres NULL-distinct semantics leave the legacy
 * every-delivery-processed behavior unchanged.
 */

/** Max accepted externalId length; longer values are treated as absent. */
const EXTERNAL_ID_MAX_LENGTH = 512;

/** A pending receipt older than this may be taken over by a later arrival. */
const PENDING_TAKEOVER_MS = 5 * 60 * 1000;

/** Bounded attempts to resolve a receipt race before failing closed. */
const RECEIPT_ATTEMPTS = 3;

function normalizeCandidate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EXTERNAL_ID_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Extract the external delivery identifier for deduplication, or null when
 * none of the conservative sources provides one.
 */
export function extractExternalId(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): string | null {
  const candidates = [headers["x-delivery-id"], headers["x-webhook-id"], payload["deliveryId"]];
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

export interface IngestWebhookInput {
  pluginId: string;
  endpointKey: string;
  /** Lowercased single-string headers stored on the receipt row. */
  headers: Record<string, string>;
  /** Raw express headers (may hold arrays) forwarded to the worker RPC. */
  reqHeaders: Record<string, string | string[]>;
  rawBody: string;
  parsedBody: unknown;
  payload: Record<string, unknown>;
}

export interface IngestWebhookResult {
  httpStatus: number;
  body: { deliveryId: string; status: "success" | "failed" | "duplicate"; error?: string };
}

type ReceiptDecision = { dispatch: true; deliveryId: string } | { dispatch: false; deliveryId: string };

async function insertPendingReceipt(db: Db, input: IngestWebhookInput, externalId: string | null) {
  const [row] = await db
    .insert(pluginWebhookDeliveries)
    .values({
      pluginId: input.pluginId,
      webhookKey: input.endpointKey,
      externalId,
      status: "pending",
      payload: input.payload,
      headers: input.headers,
      startedAt: new Date(),
    })
    .returning({ id: pluginWebhookDeliveries.id });
  return row.id;
}

async function acquireDeduplicatedReceipt(
  db: Db,
  input: IngestWebhookInput,
  externalId: string,
): Promise<ReceiptDecision> {
  const receiptTarget = [
    pluginWebhookDeliveries.pluginId,
    pluginWebhookDeliveries.webhookKey,
    pluginWebhookDeliveries.externalId,
  ];

  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
    const inserted = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: input.pluginId,
        webhookKey: input.endpointKey,
        externalId,
        status: "pending",
        payload: input.payload,
        headers: input.headers,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: receiptTarget })
      .returning({ id: pluginWebhookDeliveries.id });
    if (inserted.length > 0) return { dispatch: true, deliveryId: inserted[0].id };

    const [existing] = await db
      .select({
        id: pluginWebhookDeliveries.id,
        status: pluginWebhookDeliveries.status,
        startedAt: pluginWebhookDeliveries.startedAt,
      })
      .from(pluginWebhookDeliveries)
      .where(
        and(
          eq(pluginWebhookDeliveries.pluginId, input.pluginId),
          eq(pluginWebhookDeliveries.webhookKey, input.endpointKey),
          eq(pluginWebhookDeliveries.externalId, externalId),
        ),
      );
    if (!existing) continue; // receipt vanished between conflict and read — retry

    if (existing.status === "failed") {
      // Provider retry of a failed delivery is valid: reuse the row, keep uniqueness.
      const reused = await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "pending",
          error: null,
          durationMs: null,
          finishedAt: null,
          startedAt: new Date(),
          payload: input.payload,
          headers: input.headers,
        })
        .where(
          and(eq(pluginWebhookDeliveries.id, existing.id), eq(pluginWebhookDeliveries.status, "failed")),
        )
        .returning({ id: pluginWebhookDeliveries.id });
      if (reused.length > 0) return { dispatch: true, deliveryId: existing.id };
    } else if (existing.status === "pending") {
      // Concurrent arrivals see the winner's pending row and answer duplicate.
      // An abandoned pending receipt (crashed dispatch) is taken over instead.
      const cutoff = new Date(Date.now() - PENDING_TAKEOVER_MS);
      const took = await db
        .update(pluginWebhookDeliveries)
        .set({ startedAt: new Date(), payload: input.payload, headers: input.headers })
        .where(
          and(
            eq(pluginWebhookDeliveries.id, existing.id),
            eq(pluginWebhookDeliveries.status, "pending"),
            lt(pluginWebhookDeliveries.startedAt, cutoff),
          ),
        )
        .returning({ id: pluginWebhookDeliveries.id });
      if (took.length > 0) return { dispatch: true, deliveryId: existing.id };
    }
    return { dispatch: false, deliveryId: existing.id };
  }
  // Fail closed: the provider's retry policy re-drives the delivery.
  throw new Error(
    `Webhook receipt race unresolved after ${RECEIPT_ATTEMPTS} attempts ` +
      `(plugin ${input.pluginId}, endpoint ${input.endpointKey}, externalId ${externalId})`,
  );
}

async function dispatchReceipt(
  db: Db,
  workerManager: Pick<PluginWorkerManager, "call">,
  input: IngestWebhookInput,
  deliveryId: string,
): Promise<IngestWebhookResult> {
  const requestId = randomUUID();
  const startedAt = new Date();
  try {
    await workerManager.call(input.pluginId, "handleWebhook", {
      endpointKey: input.endpointKey,
      headers: input.reqHeaders,
      rawBody: input.rawBody,
      parsedBody: input.parsedBody,
      requestId,
    });
    const finishedAt = new Date();
    await db
      .update(pluginWebhookDeliveries)
      .set({ status: "success", durationMs: finishedAt.getTime() - startedAt.getTime(), finishedAt })
      .where(eq(pluginWebhookDeliveries.id, deliveryId));
    return { httpStatus: 200, body: { deliveryId, status: "success" } };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    await db
      .update(pluginWebhookDeliveries)
      .set({
        status: "failed",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: errorMessage,
        finishedAt,
      })
      .where(eq(pluginWebhookDeliveries.id, deliveryId));
    return { httpStatus: 502, body: { deliveryId, status: "failed", error: errorMessage } };
  }
}

/**
 * Record an inbound webhook receipt (deduplicating by external id) and, when
 * this request owns the receipt, dispatch it to the plugin worker exactly once.
 */
export async function ingestWebhookDelivery(
  db: Db,
  workerManager: Pick<PluginWorkerManager, "call">,
  input: IngestWebhookInput,
): Promise<IngestWebhookResult> {
  const externalId = extractExternalId(input.headers, input.payload);
  const decision =
    externalId === null
      ? ({ dispatch: true, deliveryId: await insertPendingReceipt(db, input, null) } as const)
      : await acquireDeduplicatedReceipt(db, input, externalId);

  if (!decision.dispatch) {
    return { httpStatus: 200, body: { deliveryId: decision.deliveryId, status: "duplicate" } };
  }
  return dispatchReceipt(db, workerManager, input, decision.deliveryId);
}
