/**
 * SRB Webhook Route
 *
 * Receives inbound SRB webhook deliveries from remote servers.
 *
 * Endpoint:
 * - POST /srb/webhook
 *
 * Security:
 * - X-SRB-Timestamp: unix seconds. |now - ts| > 300s → 401
 * - X-SRB-Signature: HMAC-SHA256 of "timestamp.body" with shared secret
 * - X-SRB-Idempotency-Key: stored in srb_nonces for replay protection (unique constraint)
 *
 * OQ-7: dual-secret 24h overlap window is supported by attempting verification
 * with both the current and previous secret version.
 */

import crypto from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { srbLinks, srbNonces, companySecrets } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { logger } from "../middleware/logger.js";
import { srbWebhookDeliveries } from "./metrics.js";
import { tracer } from "../lib/tracer.js";
import { SpanStatusCode } from "@opentelemetry/api";
import { getAlertRules } from "../services/alert-rules.js";
import { createSrbInboundHandler } from "../services/srb/inbound.js";

/**
 * Maximum allowed clock skew in seconds.
 */
const MAX_CLOCK_SKEW_SECONDS = 300;

function isDuplicateNonceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
  return candidate.code === "23505"
    || candidate.constraint === "srb_nonces_pkey"
    || candidate.constraint_name === "srb_nonces_pkey"
    || candidate.message?.includes("srb_nonces") === true;
}

/**
 * Verify HMAC-SHA256 signature against the raw request body.
 * Signature format: HMAC-SHA256("${timestamp}.${body}", secret)
 */
function verifyHmac(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  const message = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export function srbWebhookRoutes(db: Db) {
  const router = Router();
  const secrets = secretService(db);
  const inbound = createSrbInboundHandler(db);

  /**
   * POST /srb/webhook
   *
   * Receive an inbound SRB webhook delivery.
   *
   * Required headers:
   *   X-SRB-Link-Id          — the SRB link ID this delivery is for
   *   X-SRB-Timestamp        — unix seconds (integer)
   *   X-SRB-Signature        — HMAC-SHA256 hex digest
   *   X-SRB-Idempotency-Key  — unique nonce for replay protection
   */
  router.post("/srb/webhook", async (req, res) => {
    const span = tracer.startSpan("srb.route", {
      attributes: { "srb.direction": "inbound" },
    });

    const endSpan = (outcome: string, statusCode?: SpanStatusCode) => {
      span.setAttribute("srb.outcome", outcome);
      span.setStatus({ code: statusCode ?? SpanStatusCode.OK });
      span.end();
    };

    const linkId = req.headers["x-srb-link-id"] as string | undefined;
    const timestampHeader = req.headers["x-srb-timestamp"] as string | undefined;
    const signature = req.headers["x-srb-signature"] as string | undefined;
    const idempotencyKey = req.headers["x-srb-idempotency-key"] as string | undefined;

    if (!linkId || !timestampHeader || !signature || !idempotencyKey) {
      endSpan("missing_headers");
      res.status(400).json({ error: "Missing required SRB headers" });
      return;
    }

    span.setAttribute("srb.link_id", linkId);

    // Timestamp validation — reject requests outside ±300s window
    const ts = parseInt(timestampHeader, 10);
    if (!Number.isFinite(ts)) {
      endSpan("invalid_timestamp");
      res.status(400).json({ error: "Invalid X-SRB-Timestamp" });
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > MAX_CLOCK_SKEW_SECONDS) {
      endSpan("timestamp_skew");
      res.status(401).json({ error: "Request timestamp outside allowed window" });
      return;
    }

    // Load the SRB link
    const [link] = await db
      .select()
      .from(srbLinks)
      .where(eq(srbLinks.id, linkId))
      .limit(1);

    if (!link) {
      endSpan("link_not_found");
      res.status(404).json({ error: "SRB link not found" });
      return;
    }

    if (!link.sharedSecretId) {
      endSpan("no_shared_secret");
      res.status(401).json({ error: "SRB link has no shared secret configured" });
      return;
    }

    // HMAC verification — support dual-secret 24h overlap (OQ-7)
    // Try latest version first, then previous version if latest fails
    const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
    let verified = false;

    try {
      const latestSecretValue = await secrets.resolveSecretValue(
        link.localCompanyId,
        link.sharedSecretId,
        "latest",
      );
      verified = verifyHmac(rawBody, timestampHeader, signature, latestSecretValue);

      // OQ-7: if latest fails, try previous version (24h dual-secret overlap window)
      if (!verified) {
        const secretMeta = await db
          .select({ latestVersion: companySecrets.latestVersion })
          .from(companySecrets)
          .where(eq(companySecrets.id, link.sharedSecretId))
          .limit(1);
        const latestVersion = secretMeta[0]?.latestVersion ?? 1;
        if (latestVersion > 1) {
          try {
            const prevSecretValue = await secrets.resolveSecretValue(
              link.localCompanyId,
              link.sharedSecretId,
              latestVersion - 1,
            );
            verified = verifyHmac(rawBody, timestampHeader, signature, prevSecretValue);
          } catch {
            // Previous version not resolvable — continue with current verified=false
          }
        }
      }
    } catch (err) {
      logger.warn({ err, linkId }, "SRB webhook: failed to resolve secret for HMAC verification");
      getAlertRules().recordSrbFailure();
      endSpan("secret_resolution_error", SpanStatusCode.ERROR);
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    if (!verified) {
      srbWebhookDeliveries.inc({ status: "signature_rejected" });
      getAlertRules().recordSrbFailure();
      endSpan("signature_rejected");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const event = typeof body.event === "string" ? body.event : "unknown";

    try {
      await db.transaction(async (tx) => {
        const txDb = tx as Pick<Db, "insert" | "update" | "select" | "delete">;

        await txDb.insert(srbNonces).values({
          idempotencyKey,
          linkId,
        });

        await inbound.receive(txDb, {
          linkId,
          targetCompanyId: link.localCompanyId,
          event,
          payload: (body.payload ?? {}) as Record<string, unknown>,
          idempotencyKey,
        });
      });
    } catch (err) {
      if (isDuplicateNonceError(err)) {
        logger.warn({ err, idempotencyKey, linkId }, "SRB webhook: duplicate idempotency key rejected");
        endSpan("duplicate_nonce");
        res.status(409).json({ error: "Duplicate idempotency key" });
        return;
      }

      logger.warn({ err, idempotencyKey, linkId }, "SRB webhook: failed after verification");
      getAlertRules().recordSrbFailure();
      endSpan("processing_failed", SpanStatusCode.ERROR);
      res.status(422).json({ error: "SRB payload could not be applied" });
      return;
    }

    // P9-T4: track delivery receipt for SLI
    srbWebhookDeliveries.inc({ status: "received" });
    getAlertRules().recordSrbSuccess();

    logger.info({ linkId, idempotencyKey, event }, "SRB webhook received and verified");

    span.setAttribute("srb.event", event);
    endSpan("received");
    res.status(200).json({ ok: true });
  });

  return router;
}
