/**
 * Alert Rules Service
 *
 * Monitors three alert conditions and fires Telegram notifications:
 *
 * 1. scheduler_down     — no scheduler poll for ≥ 2 minutes
 * 2. srb_consecutive_failures — 3+ consecutive SRB webhook signature/validation failures
 * 3. worktree_must_block_spike — ≥ 10 MUST blocks within a 5-minute sliding window
 *
 * Usage:
 *   const alertRules = createAlertRules(getSchedulerState, sendAlert);
 *   alertRules.start();
 *   // In worktree harness: alertRules.recordMustBlock(companyId)
 *   // In srb-webhook: alertRules.recordSrbFailure() / alertRules.recordSrbSuccess()
 */

import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const SCHEDULER_DOWN_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const SRB_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const MUST_BLOCK_SPIKE_THRESHOLD = 10;
const MUST_BLOCK_WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window
const ALERT_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerState {
  running: boolean;
  lastPollAt: Date | null;
}

export type AlertSender = (message: string) => Promise<void>;

export interface AlertRules {
  start: () => void;
  stop: () => void;
  recordSrbFailure: () => void;
  recordSrbSuccess: () => void;
  recordMustBlock: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the alert rules monitor.
 *
 * @param getSchedulerState  Callback returning current scheduler state
 * @param sendAlert          Callback to send an alert message (Telegram or other)
 */
export function createAlertRules(
  getSchedulerState: () => SchedulerState,
  sendAlert: AlertSender,
): AlertRules {
  // --- SRB consecutive failure state ---
  let srbConsecutiveFailures = 0;
  let srbAlertFired = false;

  // --- MUST block spike state: timestamps of recent blocks ---
  const mustBlockTimestamps: number[] = [];
  let mustBlockAlertFiredAt: number | null = null;

  // --- Scheduler down alert state ---
  let schedulerDownAlertFiredAt: number | null = null;

  let timer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Alert helpers
  // ---------------------------------------------------------------------------

  async function fireAlert(ruleName: string, message: string): Promise<void> {
    logger.warn({ msg: "Alert fired", rule: ruleName, alert: message });
    try {
      await sendAlert(message);
    } catch (err) {
      logger.error({ msg: "Failed to send alert", rule: ruleName, err });
    }
  }

  // ---------------------------------------------------------------------------
  // Rule evaluators
  // ---------------------------------------------------------------------------

  async function checkSchedulerDown(): Promise<void> {
    const state = getSchedulerState();
    const now = Date.now();

    if (!state.running) {
      // Scheduler not running at all — always alert (but rate-limit to once per 2 min)
      if (
        schedulerDownAlertFiredAt === null ||
        now - schedulerDownAlertFiredAt >= SCHEDULER_DOWN_THRESHOLD_MS
      ) {
        schedulerDownAlertFiredAt = now;
        await fireAlert(
          "scheduler_down",
          "\u26A0\uFE0F *Alert: Scheduler Down*\nScheduler is not running.",
        );
      }
      return;
    }

    if (state.lastPollAt === null) {
      // Running but never polled — fine, just started
      return;
    }

    const idleMs = now - state.lastPollAt.getTime();
    if (idleMs >= SCHEDULER_DOWN_THRESHOLD_MS) {
      // Rate-limit: only re-fire after another 2 minutes
      if (
        schedulerDownAlertFiredAt === null ||
        now - schedulerDownAlertFiredAt >= SCHEDULER_DOWN_THRESHOLD_MS
      ) {
        schedulerDownAlertFiredAt = now;
        const idleSec = Math.round(idleMs / 1000);
        await fireAlert(
          "scheduler_down",
          `\u26A0\uFE0F *Alert: Scheduler Down*\nNo scheduler poll for ${idleSec}s (threshold: ${SCHEDULER_DOWN_THRESHOLD_MS / 1000}s).`,
        );
      }
    } else {
      // Scheduler is healthy — reset alert state
      schedulerDownAlertFiredAt = null;
    }
  }

  async function checkMustBlockSpike(): Promise<void> {
    const now = Date.now();
    const windowStart = now - MUST_BLOCK_WINDOW_MS;

    // Evict timestamps outside the window
    while (mustBlockTimestamps.length > 0 && mustBlockTimestamps[0] < windowStart) {
      mustBlockTimestamps.shift();
    }

    if (mustBlockTimestamps.length >= MUST_BLOCK_SPIKE_THRESHOLD) {
      // Rate-limit: only re-fire after window elapses
      if (
        mustBlockAlertFiredAt === null ||
        now - mustBlockAlertFiredAt >= MUST_BLOCK_WINDOW_MS
      ) {
        mustBlockAlertFiredAt = now;
        await fireAlert(
          "worktree_must_block_spike",
          `\u{1F6A8} *Alert: Worktree MUST Block Spike*\n${mustBlockTimestamps.length} MUST blocks in the last ${MUST_BLOCK_WINDOW_MS / 60_000} minutes (threshold: ${MUST_BLOCK_SPIKE_THRESHOLD}).`,
        );
      }
    } else {
      mustBlockAlertFiredAt = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public event recorders
  // ---------------------------------------------------------------------------

  function recordSrbFailure(): void {
    srbConsecutiveFailures++;
    if (srbConsecutiveFailures >= SRB_CONSECUTIVE_FAILURE_THRESHOLD && !srbAlertFired) {
      srbAlertFired = true;
      void fireAlert(
        "srb_consecutive_failures",
        `\u26A0\uFE0F *Alert: SRB Consecutive Failures*\n${srbConsecutiveFailures} consecutive SRB delivery failures detected.`,
      );
    }
  }

  function recordSrbSuccess(): void {
    if (srbConsecutiveFailures > 0) {
      srbConsecutiveFailures = 0;
      srbAlertFired = false;
    }
  }

  function recordMustBlock(): void {
    mustBlockTimestamps.push(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start(): void {
    if (timer !== null) return;

    timer = setInterval(() => {
      void checkSchedulerDown().catch((err) =>
        logger.error({ msg: "Alert rule error: scheduler_down", err }),
      );
      void checkMustBlockSpike().catch((err) =>
        logger.error({ msg: "Alert rule error: must_block_spike", err }),
      );
    }, ALERT_CHECK_INTERVAL_MS);

    logger.info({ msg: "Alert rules started", checkIntervalMs: ALERT_CHECK_INTERVAL_MS });
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    logger.info({ msg: "Alert rules stopped" });
  }

  return {
    start,
    stop,
    recordSrbFailure,
    recordSrbSuccess,
    recordMustBlock,
  };
}

export type AlertRulesService = ReturnType<typeof createAlertRules>;

// ---------------------------------------------------------------------------
// Module-level singleton (initialized from app.ts)
// ---------------------------------------------------------------------------

let _instance: AlertRulesService | null = null;

/**
 * Set the global alert rules instance.
 * Called from app.ts after createAlertRules().
 */
export function setAlertRules(instance: AlertRulesService): void {
  _instance = instance;
}

/**
 * Get the global alert rules instance.
 * Returns a no-op stub when not yet initialized (safe to call at import time).
 */
export function getAlertRules(): AlertRulesService {
  if (_instance) return _instance;
  // No-op stub — used before initialization (e.g., during tests or early boot)
  return {
    start: () => {},
    stop: () => {},
    recordSrbFailure: () => {},
    recordSrbSuccess: () => {},
    recordMustBlock: () => {},
  };
}
