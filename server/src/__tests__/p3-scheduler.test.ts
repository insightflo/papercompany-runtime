/**
 * P3-T6: Cron schedule verification tests.
 *
 * Tests computeNextRun (timezone-aware) from the scheduler service and
 * parseCron from the cron parser.
 *
 * All tests are pure unit tests — no DB, no network, no timers.
 */

import { describe, it, expect, vi } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  schedules: {},
}));

import { claimDueSchedules, computeNextRun, createScheduler } from "../services/scheduler/cron-wakeup.js";
import { parseCron, validateCron } from "../services/cron.js";

// ---------------------------------------------------------------------------
// parseCron — basic correctness
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  it("parses '* * * * *' into full-range arrays", () => {
    const parsed = parseCron("* * * * *");
    expect(parsed.minutes).toHaveLength(60); // 0-59
    expect(parsed.hours).toHaveLength(24);   // 0-23
    expect(parsed.daysOfMonth).toHaveLength(31); // 1-31
    expect(parsed.months).toHaveLength(12);   // 1-12
    expect(parsed.daysOfWeek).toHaveLength(7); // 0-6
  });

  it("parses '0 * * * *' so minutes === [0]", () => {
    const parsed = parseCron("0 * * * *");
    expect(parsed.minutes).toEqual([0]);
    expect(parsed.hours).toHaveLength(24);
  });

  it("parses '*/5 * * * *' into every-5-minute values", () => {
    const parsed = parseCron("*/5 * * * *");
    expect(parsed.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("parses '0 9-17 * * 1-5' (business hours weekdays)", () => {
    const parsed = parseCron("0 9-17 * * 1-5");
    expect(parsed.minutes).toEqual([0]);
    expect(parsed.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parsed.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws on an empty string", () => {
    expect(() => parseCron("")).toThrow();
  });

  it("throws on a 4-field expression", () => {
    expect(() => parseCron("* * * *")).toThrow();
  });

  it("throws on an out-of-range minute value", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
  });

  it("throws on a negative value", () => {
    expect(() => parseCron("-1 * * * *")).toThrow();
  });
});

describe("validateCron", () => {
  it("returns null for a valid expression", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 0 * * *")).toBeNull();
  });

  it("returns an error string for an invalid expression", () => {
    const err = validateCron("not a cron expression");
    expect(typeof err).toBe("string");
    expect(err!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeNextRun — timezone-aware next-run computation
// ---------------------------------------------------------------------------

describe("computeNextRun", () => {
  // Use a fixed reference point to make tests deterministic:
  // 2026-04-02T12:00:00Z (Thursday, noon UTC)
  const REF = new Date("2026-04-02T12:00:00Z");

  it("'*/5 * * * *' → next run is within 5 minutes of the reference time", () => {
    const next = computeNextRun("*/5 * * * *", "UTC", REF);

    expect(next).not.toBeNull();
    const diffMs = next!.getTime() - REF.getTime();
    // Must be strictly in the future but no more than 5 minutes ahead
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("'0 * * * *' → next run lands exactly at the top of an hour", () => {
    const next = computeNextRun("0 * * * *", "UTC", REF);

    expect(next).not.toBeNull();
    // Must be strictly after REF
    expect(next!.getTime()).toBeGreaterThan(REF.getTime());

    // In UTC, minute of the next run must be 0
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCSeconds()).toBe(0);
    expect(next!.getUTCMilliseconds()).toBe(0);
  });

  it("'0 * * * *' → next run is at most 60 minutes after the reference time", () => {
    const next = computeNextRun("0 * * * *", "UTC", REF);

    expect(next).not.toBeNull();
    const diffMs = next!.getTime() - REF.getTime();
    expect(diffMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("invalid cron expression → returns null", () => {
    expect(computeNextRun("not-a-cron", "UTC", REF)).toBeNull();
    expect(computeNextRun("", "UTC", REF)).toBeNull();
    expect(computeNextRun("99 * * * *", "UTC", REF)).toBeNull();
  });

  it("'*/5 * * * *' with timezone 'America/New_York' → returns a valid Date", () => {
    const next = computeNextRun("*/5 * * * *", "America/New_York", REF);

    expect(next).not.toBeNull();
    expect(next).toBeInstanceOf(Date);
    expect(isNaN(next!.getTime())).toBe(false);
  });

  it("'*/5 * * * *' with timezone 'Asia/Seoul' → returns a Date within 5 minutes", () => {
    const next = computeNextRun("*/5 * * * *", "Asia/Seoul", REF);

    expect(next).not.toBeNull();
    const diffMs = next!.getTime() - REF.getTime();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("'0 9 * * 1' (Mondays at 9am) → next is strictly after REF", () => {
    // REF is a Thursday, so next Monday is several days away
    const next = computeNextRun("0 9 * * 1", "UTC", REF);

    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(REF.getTime());
    // Should land on a Monday (UTC day 1)
    expect(next!.getUTCDay()).toBe(1);
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("'0 0 29 2 *' (Feb 29 — rare) → returns a Date or null, never throws", () => {
    // This cron is valid syntax but only matches on leap years.
    // The important contract is: it must not throw.
    let next: Date | null = null;
    expect(() => {
      next = computeNextRun("0 0 29 2 *", "UTC", REF);
    }).not.toThrow();

    // If it finds a match it should be a valid date
    if (next !== null) {
      expect((next as Date)).toBeInstanceOf(Date);
    }
  });

  it("'0 * * * *' America/New_York → result minute is 0 in local time", () => {
    const next = computeNextRun("0 * * * *", "America/New_York", REF);

    expect(next).not.toBeNull();
    // Verify the minute is 0 when formatted in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      minute: "numeric",
    });
    const parts = formatter.formatToParts(next!);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "-1");
    expect(minute).toBe(0);
  });
});

describe("createScheduler", () => {
  it("forwards mission-aware scheduler wakeups to heartbeat enqueueWakeup", async () => {
    const updateWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const db = {
      execute: vi.fn(async () => [
        {
          id: "schedule-1",
          company_id: "company-1",
          agent_id: "agent-1",
          mission_id: "mission-1",
          cron_expression: "* * * * *",
          timezone: "UTC",
        },
      ]),
      update: vi.fn(() => ({ set: updateSet })),
    } as unknown as import("@paperclipai/db").Db;
    const enqueueWakeup = vi.fn(async () => undefined);
    const scheduler = createScheduler(db, {
      heartbeat: { enqueueWakeup },
    });

    await scheduler.pollCycle();

    expect(enqueueWakeup).toHaveBeenCalledWith("agent-1", {
      source: "scheduler",
      triggerDetail: "schedule:schedule-1",
      missionId: "mission-1",
      reason: "scheduled_wakeup",
    });
    expect(updateWhere).toHaveBeenCalled();
  });
});

describe("claimDueSchedules", () => {
  it("formats the claim timestamp as ISO text before executing the raw SQL update", async () => {
    const toISOStringSpy = vi.spyOn(Date.prototype, "toISOString");
    const db = {
      execute: vi.fn(async () => []),
    } as unknown as import("@paperclipai/db").Db;

    await claimDueSchedules(db);

    expect(toISOStringSpy).toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
