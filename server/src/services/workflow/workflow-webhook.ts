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
 * The current v1 signature covers timestamp and body, but not the separate
 * idempotency-key header. Previous secret versions are honored only within a
 * 24h rotation window; expired previous versions are rejected.
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

export { WEBHOOK_MAX_CLOCK_SKEW_SECONDS, verifyWebhookSignature } from "./webhook-signature.js";
export type { WebhookSecretCandidate } from "./webhook-signature.js";

/**
 * Dual-secret rotation window: the previous secret version is honored only
 * within 24h of its creation (OQ-7 anchor), and never after revocation.
 */
export const WEBHOOK_PREVIOUS_SECRET_WINDOW_MS = 24 * 3_600_000;

export const WORKFLOW_WEBHOOK_SECRET_REF_PREFIX = "workflow-webhook:";


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
