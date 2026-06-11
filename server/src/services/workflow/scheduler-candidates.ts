import type { Db } from "@paperclipai/db";
import { companies, workflowDefinitions } from "@paperclipai/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { parseCron, type ParsedCron } from "../cron.js";

export interface ScheduledWorkflowCandidateSource {
  id: string;
  companyId: string;
  name: string;
  status: string;
  schedule: string | null;
  timezone: string | null;
  companyTimezone: string | null;
  lastScheduledRunAt: Date | null;
}

export interface ScheduledWorkflowCandidate {
  workflowId: string;
  companyId: string;
  workflowName: string;
  schedule: string;
  timezone: string;
  scheduledAt: Date;
  runDate: string;
}

export interface ComputeDueScheduledWorkflowCandidatesOptions {
  now?: Date;
  defaultTimezone?: string;
  lookbackMinutes?: number;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function readDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day" | "hour" | "minute" | "second",
): number | null {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) return null;
  const parsed = Number(part.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getZonedDateTimeParts(date: Date, timezone: string): ZonedDateTimeParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const year = readDateTimePart(parts, "year");
    const month = readDateTimePart(parts, "month");
    const day = readDateTimePart(parts, "day");
    const hour = readDateTimePart(parts, "hour");
    const minute = readDateTimePart(parts, "minute");
    const second = readDateTimePart(parts, "second");

    if (
      year === null ||
      month === null ||
      day === null ||
      hour === null ||
      minute === null ||
      second === null
    ) {
      return null;
    }

    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
  } catch {
    return null;
  }
}

function formatDateKeyInTimezone(date: Date, timezone: string): string | null {
  const parts = getZonedDateTimeParts(date, timezone);
  if (!parts) return null;
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function cronMatchesInTimezone(cron: ParsedCron, at: Date, timezone: string): boolean {
  const parts = getZonedDateTimeParts(at, timezone);
  if (!parts) return false;

  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

export function findRecentScheduledSlot(
  cronExpression: string,
  now: Date,
  timezone = "UTC",
  lookbackMinutes = 15,
): Date | null {
  let cron: ParsedCron;
  try {
    cron = parseCron(cronExpression);
  } catch {
    return null;
  }

  const normalized = new Date(now);
  normalized.setUTCSeconds(0, 0);

  for (let delta = 0; delta <= lookbackMinutes; delta += 1) {
    const candidate = new Date(normalized.getTime() - delta * 60_000);
    if (cronMatchesInTimezone(cron, candidate, timezone)) {
      return candidate;
    }
  }

  return null;
}

export function computeDueScheduledWorkflowCandidates(
  sources: ScheduledWorkflowCandidateSource[],
  options: ComputeDueScheduledWorkflowCandidatesOptions = {},
): ScheduledWorkflowCandidate[] {
  const now = options.now ?? new Date();
  const defaultTimezone = options.defaultTimezone ?? "UTC";
  const lookbackMinutes = options.lookbackMinutes ?? 15;
  const candidates: ScheduledWorkflowCandidate[] = [];

  for (const source of sources) {
    if (source.status !== "active") continue;

    const schedule = source.schedule?.trim();
    if (!schedule) continue;

    const timezone = source.timezone?.trim() || source.companyTimezone?.trim() || defaultTimezone;
    const scheduledAt = findRecentScheduledSlot(schedule, now, timezone, lookbackMinutes);
    if (!scheduledAt) continue;

    const lastScheduledRunAtMs = source.lastScheduledRunAt?.getTime();
    if (lastScheduledRunAtMs !== undefined && Number.isFinite(lastScheduledRunAtMs)) {
      if (lastScheduledRunAtMs >= scheduledAt.getTime()) continue;
    }

    candidates.push({
      workflowId: source.id,
      companyId: source.companyId,
      workflowName: source.name,
      schedule,
      timezone,
      scheduledAt,
      runDate: formatDateKeyInTimezone(scheduledAt, timezone) ?? scheduledAt.toISOString().slice(0, 10),
    });
  }

  return candidates;
}

export async function listDueScheduledWorkflowCandidates(
  db: Db,
  options: ComputeDueScheduledWorkflowCandidatesOptions = {},
): Promise<ScheduledWorkflowCandidate[]> {
  const rows = await db
    .select({
      workflow: workflowDefinitions,
      companyTimezone: companies.timezone,
    })
    .from(workflowDefinitions)
    .innerJoin(companies, eq(workflowDefinitions.companyId, companies.id))
    .where(and(
      eq(workflowDefinitions.status, "active"),
      isNotNull(workflowDefinitions.schedule),
    ));

  return computeDueScheduledWorkflowCandidates(rows.map((row) => ({
    id: row.workflow.id,
    companyId: row.workflow.companyId,
    name: row.workflow.name,
    status: row.workflow.status,
    schedule: row.workflow.schedule,
    timezone: row.workflow.timezone,
    companyTimezone: row.companyTimezone,
    lastScheduledRunAt: row.workflow.lastScheduledRunAt,
  })), options);
}
