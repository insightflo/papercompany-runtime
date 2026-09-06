/**
 * Workflow Webhook Service
 *
 * n8n-style inbound webhook support for workflow definitions.
 *
 * - Signing: HMAC-SHA256 over `${timestamp}.${rawBody}` (SRB pattern), ±300s
 *   clock skew, dual-secret rotation window against versioned company secrets.
 * - Admission: durable delivery receipts (unique per company+workflow+key) with
 *   a per-workflow quota window enforced inside the admission transaction.
 *
 * Note (SRB gap fix): the idempotency key is covered by the signature (whole
 * raw body is), and the previous secret version is only honored inside a 24h
 * rotation window; expired previous versions are rejected.
 */

import crypto from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretVersions,
  companySecrets,
  workflowWebhookDeliveries,
} from "@paperclipai/db";
import { secretService } from "../secrets.js";
import type { WorkflowRunInputDeclaration } from "./run-input-derivations.js";

/**
 * Maximum allowed clock skew in seconds (SRB anchor parity).
 */
export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Dual-secret rotation window: the previous secret version is honored only
 * within 24h of its creation (OQ-7 anchor), and never after revocation.
 */
export const WEBHOOK_PREVIOUS_SECRET_WINDOW_MS = 24 * 3_600_000;

export const WORKFLOW_WEBHOOK_SECRET_REF_PREFIX = "workflow-webhook:";

export type WebhookSecretCandidate = {
  value: string;
  expiresAt?: Date | string | null;
};

export type WebhookDeliveryQuota = { max: number; windowMs: number };

export type WorkflowWebhookSecrets = {
  current: string;
  previous: { value: string; expiresAt: Date } | null;
};

/** 429-typed error for quota exhaustion; the route maps this to HTTP 429. */
export class WebhookQuotaExceededError extends Error {
  readonly status = 429;

  constructor(message = "Webhook delivery quota exceeded for this workflow") {
    super(message);
    this.name = "WebhookQuotaExceededError";
  }
}

export function workflowWebhookSecretRef(workflowId: string): string {
  return `${WORKFLOW_WEBHOOK_SECRET_REF_PREFIX}${workflowId}`;
}

/** 32 bytes of urlsafe randomness for the HMAC signing secret. */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function webhookSecretLast4(secret: string): string {
  return secret.slice(-4);
}

function isExpired(candidate: WebhookSecretCandidate, now: number): boolean {
  if (candidate.expiresAt == null) return false;
  const expiry = candidate.expiresAt instanceof Date
    ? candidate.expiresAt.getTime()
    : Date.parse(candidate.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/**
 * Verify an HMAC-SHA256 signature against the live secrets.
 * Signature format: HMAC-SHA256("${timestamp}.${body}", secret) hex digest,
 * compared with crypto.timingSafeEqual. Expired candidates are skipped.
 */
export function verifyWebhookSignature(input: {
  timestamp: string;
  rawBody: Buffer | string;
  signature: string;
  secrets: readonly WebhookSecretCandidate[];
}): boolean {
  const { timestamp, rawBody, signature, secrets } = input;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS) return false;

  const now = Date.now();
  const message = `${timestamp}.${rawBody.toString("utf8")}`;
  for (const candidate of secrets) {
    if (isExpired(candidate, now)) continue;
    const expected = crypto
      .createHmac("sha256", candidate.value)
      .update(message)
      .digest("hex");
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
        return true;
      }
    } catch {
      // Length-mismatched or non-hex signature — keep trying remaining secrets.
    }
  }
  return false;
}

/**
 * Resolve the current (latest) and previous secret versions for a webhook
 * config. The previous version is included only while it is inside the 24h
 * rotation window and not revoked. Returns null when the referenced secret
 * does not exist (the caller must fail closed with 401).
 */
export async function resolveWorkflowWebhookSecret(
  db: Db,
  config: { companyId: string; secretRef: string },
): Promise<WorkflowWebhookSecrets | null> {
  const secrets = secretService(db);
  const [secretRow] = await db
    .select()
    .from(companySecrets)
    .where(
      and(eq(companySecrets.companyId, config.companyId), eq(companySecrets.name, config.secretRef)),
    )
    .limit(1);
  if (!secretRow) return null;

  try {
    const current = await secrets.resolveSecretValue(config.companyId, secretRow.id, "latest");
    let previous: { value: string; expiresAt: Date } | null = null;
    if (secretRow.latestVersion > 1) {
      const previousVersion = secretRow.latestVersion - 1;
      const [versionRow] = await db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            eq(companySecretVersions.secretId, secretRow.id),
            eq(companySecretVersions.version, previousVersion),
          ),
        )
        .limit(1);
      const createdAt = versionRow?.createdAt ?? null;
      const revokedAt = versionRow?.revokedAt ?? null;
      const expired = !createdAt
        || revokedAt != null
        || Date.now() - createdAt.getTime() > WEBHOOK_PREVIOUS_SECRET_WINDOW_MS;
      if (!expired) {
        previous = {
          value: await secrets.resolveSecretValue(config.companyId, secretRow.id, previousVersion),
          expiresAt: new Date(createdAt.getTime() + WEBHOOK_PREVIOUS_SECRET_WINDOW_MS),
        };
      }
    }
    return { current, previous };
  } catch {
    return null;
  }
}

/**
 * Admit an inbound webhook delivery:
 * - replay: an existing receipt for (company, workflow, key) is returned as-is
 *   (replay=true, never a second row);
 * - quota: deliveries for the workflow within the window are counted inside
 *   the same transaction; over the max, a 429-typed error is thrown;
 * - race: concurrent inserts rely on the unique index (onConflictDoNothing)
 *   and re-read the winning row.
 */
export async function admitWebhookDelivery(
  db: Db,
  input: {
    companyId: string;
    workflowId: string;
    idempotencyKey: string;
    quota: WebhookDeliveryQuota;
  },
): Promise<{ delivery: typeof workflowWebhookDeliveries.$inferSelect; replay: boolean }> {
  const { companyId, workflowId, idempotencyKey, quota } = input;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(workflowWebhookDeliveries)
      .where(
        and(
          eq(workflowWebhookDeliveries.companyId, companyId),
          eq(workflowWebhookDeliveries.workflowId, workflowId),
          eq(workflowWebhookDeliveries.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) return { delivery: existing, replay: true };

    const windowStart = new Date(Date.now() - quota.windowMs);
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowWebhookDeliveries)
      .where(
        and(
          eq(workflowWebhookDeliveries.workflowId, workflowId),
          gte(workflowWebhookDeliveries.receivedAt, windowStart),
        ),
      );
    if ((countRow?.count ?? 0) >= quota.max) {
      throw new WebhookQuotaExceededError();
    }

    const [inserted] = await tx
      .insert(workflowWebhookDeliveries)
      .values({ companyId, workflowId, idempotencyKey })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { delivery: inserted, replay: false };

    const [winner] = await tx
      .select()
      .from(workflowWebhookDeliveries)
      .where(
        and(
          eq(workflowWebhookDeliveries.companyId, companyId),
          eq(workflowWebhookDeliveries.workflowId, workflowId),
          eq(workflowWebhookDeliveries.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!winner) throw new Error("webhook delivery receipt vanished during admission");
    return { delivery: winner, replay: true };
  });
}

/**
 * Declared-input validation for webhook payloads: every required runInput
 * (required !== false) must be present with a non-empty value in the payload
 * metadata. Derivation alone does not validate plain required inputs.
 */
export function validateRequiredRunInputs(
  runInputs: readonly WorkflowRunInputDeclaration[] | undefined,
  metadata: Record<string, unknown>,
): string | null {
  for (const input of runInputs ?? []) {
    if (input.required === false) continue;
    const value = metadata[input.key];
    const present = typeof value === "string" ? value.trim().length > 0 : value != null;
    if (!present) {
      return `Missing required run input: ${input.key}`;
    }
  }
  return null;
}
