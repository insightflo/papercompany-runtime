import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { srbDeliveryLog } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export type SrbPayload = Record<string, unknown>;

type SrbInsertDb = Pick<Db, "insert">;
type SrbUpdateDb = Pick<Db, "update">;

export function buildSrbWebhookBody(event: string, payload: SrbPayload): string {
  return JSON.stringify({ event, payload });
}

export function computeSrbPayloadHash(payload: SrbPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildSrbHmacSignature(body: string, timestamp: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function buildSrbHeaders(input: {
  linkId: string;
  timestamp: number;
  idempotencyKey: string;
  signature?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-SRB-Link-Id": input.linkId,
    "X-SRB-Timestamp": String(input.timestamp),
    "X-SRB-Idempotency-Key": input.idempotencyKey,
  };

  if (input.signature) {
    headers["X-SRB-Signature"] = input.signature;
  }

  return headers;
}

export async function sendSrbWebhookRequest(input: {
  url: string;
  body: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);

  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    return await fetchImpl(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function insertSrbDeliveryLog(
  dbOrTx: SrbInsertDb,
  input: {
    linkId: string;
    event: string;
    payload: SrbPayload;
    idempotencyKey: string;
    status: string;
    attemptCount: number;
    lastAttemptAt?: Date | null;
    nextRetryAt?: Date | null;
  },
) {
  const now = new Date();
  const [delivery] = await dbOrTx
    .insert(srbDeliveryLog)
    .values({
      linkId: input.linkId,
      event: input.event,
      payloadHash: computeSrbPayloadHash(input.payload),
      payloadJson: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      attemptCount: input.attemptCount,
      lastAttemptAt: input.lastAttemptAt ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      updatedAt: now,
    })
    .returning();

  return delivery;
}

export async function updateSrbDeliveryLog(
  dbOrTx: SrbUpdateDb,
  deliveryId: string,
  patch: {
    status: string;
    attemptCount: number;
    lastAttemptAt?: Date | null;
    nextRetryAt?: Date | null;
  },
): Promise<void> {
  await dbOrTx
    .update(srbDeliveryLog)
    .set({
      status: patch.status,
      attemptCount: patch.attemptCount,
      lastAttemptAt: patch.lastAttemptAt ?? null,
      nextRetryAt: patch.nextRetryAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(srbDeliveryLog.id, deliveryId));
}
