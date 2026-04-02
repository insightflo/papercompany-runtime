/**
 * SRB Delivery Retry Worker
 *
 * Background worker that retries failed SRB webhook deliveries.
 * Uses exponential backoff with a maximum of 10 attempts.
 *
 * Backoff schedule (seconds): 30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 15360
 * (base 30s, doubles each time, capped at ~256 minutes for attempt 10)
 *
 * For each failed delivery row that has nextRetryAt <= now:
 * 1. Claim the row (update status to 'retrying')
 * 2. Attempt delivery
 * 3. On success: status → 'delivered'
 * 4. On failure and attemptCount < MAX_ATTEMPTS: compute nextRetryAt and status → 'failed'
 * 5. On failure and attemptCount >= MAX_ATTEMPTS: status → 'dead'
 */

import type { Db } from "@paperclipai/db";
import { srbDeliveryLog, srbLinks } from "@paperclipai/db";
import { eq, and, lte, inArray, or } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../secrets.js";
import {
  buildSrbHeaders,
  buildSrbHmacSignature,
  buildSrbWebhookBody,
  sendSrbWebhookRequest,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of delivery attempts before marking as 'dead'.
 */
export const MAX_DELIVERY_ATTEMPTS = 10;

/**
 * Base backoff in milliseconds (30 seconds).
 */
const BASE_BACKOFF_MS = 30_000;

/**
 * Worker polling interval in milliseconds (30 seconds).
 */
const POLL_INTERVAL_MS = 30_000;

const RETRYING_STALE_AFTER_MS = 2 * 60_000;

/**
 * Maximum deliveries to process per polling cycle.
 */
const MAX_CLAIM_PER_CYCLE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next retry timestamp using exponential backoff.
 *
 * @param attemptCount - Current attempt count (before next attempt)
 * @returns Next retry Date
 */
export function computeNextRetryAt(attemptCount: number): Date {
  const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attemptCount - 1);
  return new Date(Date.now() + backoffMs);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface DeliveryRetryWorkerState {
  running: boolean;
  lastPollAt: Date | null;
  totalAttempts: number;
  totalDelivered: number;
  totalDead: number;
}

/**
 * Create the SRB delivery retry worker.
 *
 * @param db - Database instance
 * @returns Worker control interface
 */
export function createDeliveryRetryWorker(db: Db) {
  const secrets = secretService(db);

  let state: DeliveryRetryWorkerState = {
    running: false,
    lastPollAt: null,
    totalAttempts: 0,
    totalDelivered: 0,
    totalDead: 0,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Attempt to deliver a single srb_delivery_log row.
   * Returns true on success, false on failure.
   */
  async function attemptDelivery(
    row: typeof srbDeliveryLog.$inferSelect,
  ): Promise<"delivered" | "retryable" | "abandoned"> {
    // Load the link to get remoteServerUrl and sharedSecretId
    const [link] = await db
      .select()
      .from(srbLinks)
      .where(eq(srbLinks.id, row.linkId))
      .limit(1);

    if (!link || !link.remoteServerUrl) {
      logger.warn({ deliveryId: row.id, linkId: row.linkId }, "SRB retry: link not found or no remote URL");
      return "retryable";
    }

    if (!row.payloadJson || typeof row.payloadJson !== "object") {
      logger.warn({ deliveryId: row.id }, "SRB retry: delivery has no replayable payload; abandoning");
      return "abandoned";
    }

    const payload = row.payloadJson as Record<string, unknown>;
    const bodyStr = buildSrbWebhookBody(row.event, payload);
    const timestamp = Math.floor(Date.now() / 1000);

    // Build signature if a shared secret is configured
    let signature: string | null = null;
    if (link.sharedSecretId) {
      try {
        const secretValue = await secrets.resolveSecretValue(
          link.localCompanyId,
          link.sharedSecretId,
          "latest",
        );
        signature = buildSrbHmacSignature(bodyStr, timestamp, secretValue);
      } catch (err) {
        logger.warn({ err, deliveryId: row.id }, "SRB retry: failed to resolve secret for signature");
      }
    }

    const headers = buildSrbHeaders({
      linkId: link.id,
      timestamp,
      idempotencyKey: row.idempotencyKey ?? `retry:${row.id}`,
      signature: signature ?? undefined,
    });

    try {
      const resp = await sendSrbWebhookRequest({
        url: link.remoteServerUrl,
        headers,
        body: bodyStr,
      });
      return resp.ok || resp.status === 409 ? "delivered" : "retryable";
    } catch (err) {
      logger.warn({ err, deliveryId: row.id, url: link.remoteServerUrl }, "SRB retry: HTTP delivery failed");
      return "retryable";
    }
  }

  /**
   * Execute a single polling cycle.
   */
  async function pollCycle(): Promise<void> {
    state.lastPollAt = new Date();

    const now = new Date();
    const retryingStaleBefore = new Date(now.getTime() - RETRYING_STALE_AFTER_MS);
    const due = await db
      .select()
      .from(srbDeliveryLog)
      .where(
        or(
          and(
            inArray(srbDeliveryLog.status, ["failed"]),
            lte(srbDeliveryLog.nextRetryAt, now),
          ),
          and(
            eq(srbDeliveryLog.status, "retrying"),
            lte(srbDeliveryLog.updatedAt, retryingStaleBefore),
          ),
        ),
      )
      .limit(MAX_CLAIM_PER_CYCLE);

    if (due.length === 0) return;

    for (const row of due) {
      const claimed = await db
        .update(srbDeliveryLog)
        .set({ status: "retrying", updatedAt: now })
        .where(
          and(
            eq(srbDeliveryLog.id, row.id),
            eq(srbDeliveryLog.status, row.status),
            eq(srbDeliveryLog.updatedAt, row.updatedAt),
          ),
        )
        .returning({ id: srbDeliveryLog.id });

      if (claimed.length === 0) {
        continue;
      }

      state.totalAttempts++;
      const outcome = await attemptDelivery(row);
      const newAttemptCount = (row.attemptCount ?? 0) + 1;

      if (outcome === "delivered") {
        await db
          .update(srbDeliveryLog)
          .set({
            status: "delivered",
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            updatedAt: new Date(),
          })
          .where(eq(srbDeliveryLog.id, row.id));
        state.totalDelivered++;
        logger.info({ deliveryId: row.id, attempts: newAttemptCount }, "SRB retry: delivered");
      } else if (outcome === "abandoned") {
        await db
          .update(srbDeliveryLog)
          .set({
            status: "abandoned",
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            updatedAt: new Date(),
          })
          .where(eq(srbDeliveryLog.id, row.id));
        state.totalDead++;
        logger.warn({ deliveryId: row.id, attempts: newAttemptCount }, "SRB retry: delivery abandoned due to missing replay payload");
      } else if (newAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
        await db
          .update(srbDeliveryLog)
          .set({
            status: "dead",
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            updatedAt: new Date(),
          })
          .where(eq(srbDeliveryLog.id, row.id));
        state.totalDead++;
        logger.warn({ deliveryId: row.id, attempts: newAttemptCount }, "SRB retry: delivery dead after max attempts");
      } else {
        const nextRetryAt = computeNextRetryAt(newAttemptCount);
        await db
          .update(srbDeliveryLog)
          .set({
            status: "failed",
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt,
            updatedAt: new Date(),
          })
          .where(eq(srbDeliveryLog.id, row.id));
        logger.info({ deliveryId: row.id, attempts: newAttemptCount, nextRetryAt }, "SRB retry: rescheduled");
      }
    }
  }

  return {
    start() {
      if (state.running) return;
      state.running = true;
      pollTimer = setInterval(() => {
        void pollCycle().catch((err) => {
          logger.error({ err }, "SRB delivery retry worker: poll cycle failed");
        });
      }, POLL_INTERVAL_MS);
      // Run immediately on start
      void pollCycle().catch((err) => {
        logger.error({ err }, "SRB delivery retry worker: initial poll failed");
      });
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      state.running = false;
    },

    getState(): DeliveryRetryWorkerState {
      return { ...state };
    },
  };
}

export type DeliveryRetryWorker = ReturnType<typeof createDeliveryRetryWorker>;
