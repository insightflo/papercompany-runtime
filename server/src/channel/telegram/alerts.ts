/**
 * Telegram Alert Monitor
 *
 * Watches for operational anomalies and sends Telegram alerts.
 * Thin coordination layer that delegates SRB/worktree event recording
 * to the shared alert-rules service, while also running its own 60-second
 * polling loop for any DB-sourced checks.
 *
 * Alert conditions:
 *   1. Scheduler down: no lastPollAt update in > 2 minutes
 *      (evaluated by alert-rules service; this module checks via DB when needed)
 *   2. SRB consecutive failures: 3+ consecutive delivery failures
 *      (recorded by callers via recordSrbFailure / cleared by recordSrbSuccess)
 *   3. MUST block spike: 5+ WorktreeViolations in a 60-second window
 *      (recorded via recordWorktreeViolation)
 *
 * Deduplication: alert-rules service handles dedup for conditions 1 and 2.
 * Condition 3 uses a local sliding-window timestamp list.
 *
 * Wiring:
 *   Called from app.ts after alertRules.start(), using:
 *     const stopAlerts = startAlertMonitor(db);
 *     process.once("exit", stopAlerts);
 */

import type { Db } from "@paperclipai/db";
import { getAlertRules } from "../../services/alert-rules.js";
import { getChannelRegistry } from "../index.js";
import { getChatId } from "./outbound.js";
import { logger } from "../../middleware/logger.js";

// ---------------------------------------------------------------------------
// Thresholds (task spec: 5+ violations in 60s window)
// ---------------------------------------------------------------------------

const MUST_BLOCK_SPIKE_THRESHOLD = 5;
const MUST_BLOCK_WINDOW_MS = 60_000; // 60-second sliding window
const POLL_INTERVAL_MS = 60_000; // Poll every 60 seconds

// ---------------------------------------------------------------------------
// Module-level state for WorktreeViolation spike tracking
// ---------------------------------------------------------------------------

const violationTimestamps: number[] = [];
let violationAlertFiredAt: number | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send an alert message to all active Telegram companies.
 */
async function broadcastAlert(message: string): Promise<void> {
  let registry: ReturnType<typeof getChannelRegistry>;
  try {
    registry = getChannelRegistry();
  } catch {
    // Channel registry not yet initialized — skip
    return;
  }

  const companyIds = registry.getActiveCompanyIds();
  for (const companyId of companyIds) {
    const chatId = getChatId(companyId);
    if (chatId === undefined) continue;

    const sender = registry.getTelegramSender(companyId);
    if (!sender) continue;

    try {
      await sender(chatId, message);
    } catch (err) {
      logger.warn({ err, companyId }, "alerts: failed to send alert to company");
    }
  }
}

/**
 * Evaluate the WorktreeViolation sliding-window spike condition.
 * Fires an alert when >= MUST_BLOCK_SPIKE_THRESHOLD violations occur within
 * the last MUST_BLOCK_WINDOW_MS. Clears the dedup guard once the window is
 * no longer spiking.
 */
async function checkViolationSpike(): Promise<void> {
  const now = Date.now();
  const cutoff = now - MUST_BLOCK_WINDOW_MS;

  // Evict timestamps outside the window
  while (violationTimestamps.length > 0 && violationTimestamps[0] < cutoff) {
    violationTimestamps.shift();
  }

  const count = violationTimestamps.length;

  if (count >= MUST_BLOCK_SPIKE_THRESHOLD) {
    // Alert once per spike; clear dedup when count drops below threshold
    if (
      violationAlertFiredAt === null ||
      now - violationAlertFiredAt >= MUST_BLOCK_WINDOW_MS
    ) {
      violationAlertFiredAt = now;
      logger.warn({ msg: "Alert: WorktreeViolation spike", count });
      await broadcastAlert(
        `\u26A0\uFE0F *Alert: Worktree MUST Block Spike*\n${count} MUST block violations in the last 60 seconds.`,
      );
    }
  } else {
    // Condition cleared — reset dedup guard so next spike fires fresh
    violationAlertFiredAt = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an SRB delivery failure for alert tracking.
 *
 * Delegates to the shared alert-rules service which tracks consecutive
 * failures and fires when 3+ occur without an intervening success.
 *
 * @param _linkId - SRB link ID (informational, not used for dedup key)
 */
export function recordSrbFailure(_linkId: string): void {
  getAlertRules().recordSrbFailure();
}

/**
 * Record an SRB delivery success, resetting the consecutive-failure counter.
 */
export function recordSrbSuccess(): void {
  getAlertRules().recordSrbSuccess();
}

/**
 * Record a WorktreeViolation event for the spike detector.
 *
 * Appends a timestamp to the sliding window. The polling loop evaluates
 * the window every 60 seconds and fires an alert when the threshold is met.
 */
export function recordWorktreeViolation(): void {
  violationTimestamps.push(Date.now());
}

/**
 * Start the alert monitor polling loop.
 *
 * Runs every POLL_INTERVAL_MS and checks:
 *   - WorktreeViolation spike (local state, no DB query)
 *
 * The scheduler-down and SRB-consecutive-failure conditions are handled by
 * the alert-rules service started separately from app.ts. This monitor
 * supplements those with the worktree-violation spike check.
 *
 * @param _db - Database instance (reserved for future DB-sourced checks)
 * @returns cleanup function — call to stop the polling interval
 */
export function startAlertMonitor(_db: Db): () => void {
  logger.info({ msg: "Telegram alert monitor starting", pollIntervalMs: POLL_INTERVAL_MS });

  const timer = setInterval(() => {
    void checkViolationSpike().catch((err) =>
      logger.error({ err }, "alerts: error in violation spike check"),
    );
  }, POLL_INTERVAL_MS);

  // Run an initial check immediately (don't wait for the first interval tick)
  void checkViolationSpike().catch((err) =>
    logger.error({ err }, "alerts: error in initial violation spike check"),
  );

  logger.info({ msg: "Telegram alert monitor started" });

  return () => {
    clearInterval(timer);
    logger.info({ msg: "Telegram alert monitor stopped" });
  };
}
