/**
 * SRB Nonce Cleanup Job
 *
 * Deletes srb_nonces rows older than 10 minutes.
 * Replay protection only requires nonces within the ±300s (5min) window,
 * so 10 minutes is a safe TTL.
 *
 * Runs on a configurable interval (default: 5 minutes).
 */

import type { Db } from "@paperclipai/db";
import { srbNonces } from "@paperclipai/db";
import { lt } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";

/**
 * Nonce TTL: 10 minutes in milliseconds.
 */
const NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * Cleanup poll interval: 5 minutes.
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Delete nonces older than 10 minutes.
 *
 * @param db - Database instance
 * @returns Number of deleted nonces
 */
export async function cleanupExpiredNonces(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - NONCE_TTL_MS);
  const deleted = await db
    .delete(srbNonces)
    .where(lt(srbNonces.receivedAt, cutoff))
    .returning({ id: srbNonces.idempotencyKey });
  return deleted.length;
}

/**
 * Create the nonce cleanup job.
 *
 * @param db - Database instance
 * @returns Cleanup job control interface
 */
export function createNonceCleanupJob(db: Db) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  const activeRuns = new Set<Promise<void>>();

  function trackRun(promise: Promise<void>): Promise<void> {
    activeRuns.add(promise);
    void promise.then(() => activeRuns.delete(promise), () => activeRuns.delete(promise));
    return promise;
  }

  async function run(): Promise<void> {
    try {
      const count = await cleanupExpiredNonces(db);
      if (count > 0) {
        logger.info({ count }, "SRB nonce cleanup: deleted expired nonces");
      }
    } catch (err) {
      logger.error({ err }, "SRB nonce cleanup: failed");
    }
  }

  return {
    start() {
      if (timer) return;
      const currentGeneration = ++generation;
      timer = setInterval(() => {
        if (timer && currentGeneration === generation) void trackRun(run());
      }, CLEANUP_INTERVAL_MS);
      // Run immediately on start
      void trackRun(run());
    },

    stop() {
      generation++;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async drain(): Promise<void> {
      while (activeRuns.size > 0) {
        await Promise.allSettled([...activeRuns]);
      }
    },
  };
}

export type NonceCleanupJob = ReturnType<typeof createNonceCleanupJob>;
