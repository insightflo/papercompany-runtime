/**
 * Scheduler Cron Wakeup Service
 *
 * Polling loop that claims due schedules and triggers agent wakeups.
 * Uses FOR UPDATE SKIP LOCKED for safe distributed operation.
 *
 * Architecture Plan §3.4: claim-then-run pattern
 */

import type { Db } from "@paperclipai/db";
import { schedules } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { parseCron } from "../cron.js";
import type { Schedule, ScheduleClaimResult } from "./types.js";
import { schedulerDueToWakeupLatency } from "../../routes/metrics.js";
import { withSpan } from "../../lib/tracer.js";

/**
 * Default polling interval in milliseconds (60 seconds).
 */
const SCHEDULER_POLL_INTERVAL_MS = 60_000;

/**
 * Maximum schedules to claim per polling cycle.
 */
const MAX_CLAIM_PER_CYCLE = 100;

/**
 * Compute the next run time for a cron expression.
 *
 * @param cronExpression - 5-field cron expression
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param after - Reference date (defaults to now)
 * @returns Next run Date or null if no match found
 */
export function computeNextRun(
  cronExpression: string,
  timezone: string,
  after: Date = new Date(),
): Date | null {
  try {
    const cron = parseCron(cronExpression);

    const exactUtcAnnual = computeExactUtcAnnualMatch(cron, after);
    if (exactUtcAnnual !== undefined && timezone === "UTC") {
      return exactUtcAnnual;
    }

    // Convert the reference time to the target timezone
    // We'll compute ticks in UTC and check if they match the cron schedule
    // when interpreted in the target timezone
    const cursor = new Date(after.getTime());
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMilliseconds(0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

    // Safety limit: search up to 1 year ahead (rare crons like Feb-29 may return null)
    const MAX_SEARCH_MINUTES = 366 * 24 * 60;

    // Create formatter once outside loop (Intl.DateTimeFormat construction is expensive)
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });

    for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
      // Check if this UTC time matches the cron schedule in the target timezone
      if (matchesCronInTimeZone(cron, cursor, formatter)) {
        return new Date(cursor.getTime());
      }
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }

    return null;
  } catch {
    // Invalid cron expression - return null
    return null;
  }
}

function computeExactUtcAnnualMatch(
  cron: ReturnType<typeof parseCron>,
  after: Date,
): Date | null | undefined {
  if (
    cron.minutes.length !== 1
    || cron.hours.length !== 1
    || cron.daysOfMonth.length !== 1
    || cron.months.length !== 1
  ) {
    return undefined;
  }

  const minute = cron.minutes[0]!;
  const hour = cron.hours[0]!;
  const day = cron.daysOfMonth[0]!;
  const month = cron.months[0]!;

  for (let year = after.getUTCFullYear(); year <= after.getUTCFullYear() + 8; year += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      continue;
    }
    if (!cron.daysOfWeek.includes(candidate.getUTCDay())) {
      continue;
    }
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if a given UTC date matches the cron schedule when interpreted
 * in the target timezone.
 */
function matchesCronInTimeZone(
  cron: ReturnType<typeof parseCron>,
  utcDate: Date,
  formatter: Intl.DateTimeFormat,
): boolean {
  try {
    const parts = formatter.formatToParts(utcDate);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    const weekdayIndex: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const minute = Number(map.minute);
    const hour = Number(map.hour);
    const day = Number(map.day);
    const month = Number(map.month);
    const weekday = weekdayIndex[map.weekday ?? ""] ?? 0;

    return (
      cron.minutes.includes(minute) &&
      cron.hours.includes(hour) &&
      cron.daysOfMonth.includes(day) &&
      cron.months.includes(month) &&
      cron.daysOfWeek.includes(weekday)
    );
  } catch {
    return false;
  }
}

/**
 * Claim due schedules using FOR UPDATE SKIP LOCKED pattern.
 *
 * This query:
 * 1. Finds schedules that are due (next_run_at <= now)
 * 2. Locks them with SKIP LOCKED (other concurrent workers skip these)
 * 3. Updates last_run_at and computes next_run_at
 * 4. Returns the claimed schedule data
 *
 * @param db - Database instance
 * @returns Claimed schedules with agent and mission info
 */
export async function claimDueSchedules(db: Db): Promise<ScheduleClaimResult["claimed"]> {
  const now = new Date();

  // Execute the claim-then-run query
  const result = await db.execute(
    sql`
      WITH due AS (
        SELECT id
        FROM schedules
        WHERE enabled = true
          AND next_run_at <= ${now}
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${MAX_CLAIM_PER_CYCLE}
      )
      UPDATE schedules s
      SET
        last_run_at = ${now},
        next_run_at = CASE
          WHEN s.cron_expression IS NOT NULL THEN NULL -- Will compute in next step
          ELSE NULL
        END,
        updated_at = ${now}
      FROM due
      WHERE s.id = due.id
      RETURNING
        s.id,
        s.company_id,
        s.agent_id,
        s.mission_id,
        s.cron_expression,
        s.timezone
    `
  );

  const rows = result as unknown as Array<{
    id: string;
    company_id: string;
    agent_id: string;
    mission_id: string | null;
    cron_expression: string;
    timezone: string;
  }>;

  // Now compute and update next_run_at for each claimed schedule
  for (const row of rows) {
    const nextRun = computeNextRun(row.cron_expression, row.timezone, now);
    await db
      .update(schedules)
      .set({ nextRunAt: nextRun })
      .where(eq(schedules.id, row.id));
  }

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    missionId: row.mission_id,
  }));
}

/**
 * Scheduler state and polling loop control.
 */
export interface SchedulerDeps {
  heartbeat: {
    enqueueWakeup: (
      agentId: string,
      opts?: {
        source?: string;
        triggerDetail?: string | null;
        missionId?: string;
        reason?: string;
      },
    ) => Promise<unknown>;
  };
}

export interface SchedulerState {
  running: boolean;
  lastPollAt: Date | null;
  activeScheduleCount: number;
  totalWakeupCount: number;
}

/**
 * Create a scheduler instance.
 *
 * @param db - Database instance
 * @param deps - Service dependencies
 * @returns Scheduler control interface
 */
export function createScheduler(db: Db, deps: SchedulerDeps) {
  let state: SchedulerState = {
    running: false,
    lastPollAt: null,
    activeScheduleCount: 0,
    totalWakeupCount: 0,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Execute a single polling cycle.
   */
  async function pollCycle(): Promise<void> {
    const startTime = new Date();

    await withSpan("scheduler.claimAndWakeup", {}, async (span) => {
      try {
        // Claim due schedules
        const claimed = await claimDueSchedules(db);

        span.setAttribute("scheduler.claimed_count", claimed.length);

        // Update state
        state.lastPollAt = startTime;
        state.activeScheduleCount = claimed.length;

        if (claimed.length === 0) {
          return;
        }

        let wakeupSuccess = 0;
        let wakeupFailure = 0;

        // Fire wakeups for each claimed schedule
        for (const schedule of claimed) {
          const wakeupStart = Date.now();
          try {
            await deps.heartbeat.enqueueWakeup(schedule.agentId, {
              source: "scheduler",
              triggerDetail: `schedule:${schedule.id}`,
              missionId: schedule.missionId ?? undefined,
              reason: "scheduled_wakeup",
            });
            // P9-T2: observe due-to-wakeup latency (approximate: time within poll cycle)
            schedulerDueToWakeupLatency.observe((Date.now() - wakeupStart) / 1000);
            state.totalWakeupCount++;
            wakeupSuccess++;
          } catch (error) {
            // Log error but continue with other schedules
            console.error(
              `[Scheduler] Failed to wakeup agent ${schedule.agentId} for schedule ${schedule.id}:`,
              error,
            );
            wakeupFailure++;
          }
        }

        span.setAttribute("scheduler.wakeup_success", wakeupSuccess);
        span.setAttribute("scheduler.wakeup_failure", wakeupFailure);
      } catch (error) {
        console.error("[Scheduler] Poll cycle error:", error);
        throw error;
      }
    }).catch((err) => {
      // withSpan already re-throws; swallow here to match original fire-and-forget behaviour
      console.error("[Scheduler] Poll cycle span error:", err);
    });
  }

  /**
   * Start the scheduler polling loop.
   */
  function start(): void {
    if (state.running) {
      console.warn("[Scheduler] Already running");
      return;
    }

    state.running = true;
    console.log(`[Scheduler] Started polling every ${SCHEDULER_POLL_INTERVAL_MS}ms`);

    // Run first poll immediately
    pollCycle().catch((err) => console.error("[Scheduler] Initial poll error:", err));

    // Set up recurring polls
    pollTimer = setInterval(() => {
      pollCycle().catch((err) => console.error("[Scheduler] Poll error:", err));
    }, SCHEDULER_POLL_INTERVAL_MS);
  }

  /**
   * Stop the scheduler polling loop.
   */
  function stop(): void {
    if (!state.running) {
      return;
    }

    state.running = false;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    console.log("[Scheduler] Stopped");
  }

  /**
   * Get current scheduler state.
   */
  function getState(): SchedulerState {
    return { ...state };
  }

  return {
    start,
    stop,
    getState,
    pollCycle,
  };
}

/**
 * Re-export types for convenience.
 */
export type { Schedule, CreateScheduleInput, UpdateScheduleInput } from "./types.js";
