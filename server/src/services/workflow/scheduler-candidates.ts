import type { Db } from "@paperclipai/db";
import { companies, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  maxDailyRuns?: number | null;
  maxConcurrentRuns?: number | null;
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

async function countScheduledRunsForDay(
  db: Db,
  input: { workflowId: string; companyId: string; runDate: string },
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.workflowId, input.workflowId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.triggerSource, "schedule"),
      eq(workflowRuns.runDate, input.runDate),
    ));

  return Number(rows[0]?.count ?? 0);
}

async function hasBlockingSameDayRun(
  db: Db,
  input: { workflowId: string; companyId: string; runDate: string },
): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.workflowId, input.workflowId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.runDate, input.runDate),
      inArray(workflowRuns.status, ["running", "completed"]),
    ));

  return Number(rows[0]?.count ?? 0) > 0;
}

async function countRunningWorkflowRuns(
  db: Db,
  input: { workflowId: string; companyId: string },
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.workflowId, input.workflowId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.status, "running"),
    ));

  return Number(rows[0]?.count ?? 0);
}

async function passesScheduledRunGuards(
  db: Db,
  source: ScheduledWorkflowCandidateSource,
  candidate: ScheduledWorkflowCandidate,
): Promise<boolean> {
  const maxConcurrentRuns = source.maxConcurrentRuns ?? null;
  if (typeof maxConcurrentRuns === "number" && maxConcurrentRuns > 0) {
    const runningCount = await countRunningWorkflowRuns(db, {
      workflowId: candidate.workflowId,
      companyId: candidate.companyId,
    });
    if (runningCount >= maxConcurrentRuns) return false;
  }

  const maxDailyRuns = source.maxDailyRuns ?? null;
  if (maxDailyRuns === 0) return true;

  if (typeof maxDailyRuns === "number" && maxDailyRuns > 0) {
    const scheduledRunsToday = await countScheduledRunsForDay(db, {
      workflowId: candidate.workflowId,
      companyId: candidate.companyId,
      runDate: candidate.runDate,
    });
    return scheduledRunsToday < maxDailyRuns;
  }

  return !(await hasBlockingSameDayRun(db, {
    workflowId: candidate.workflowId,
    companyId: candidate.companyId,
    runDate: candidate.runDate,
  }));
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

  const sources = rows.map((row) => ({
    id: row.workflow.id,
    companyId: row.workflow.companyId,
    name: row.workflow.name,
    status: row.workflow.status,
    schedule: row.workflow.schedule,
    timezone: row.workflow.timezone,
    companyTimezone: row.companyTimezone,
    lastScheduledRunAt: row.workflow.lastScheduledRunAt,
    maxDailyRuns: row.workflow.maxDailyRuns,
    maxConcurrentRuns: row.workflow.maxConcurrentRuns,
  }));
  const sourceByWorkflowId = new Map(sources.map((source) => [source.id, source]));
  const candidates = computeDueScheduledWorkflowCandidates(sources, options);
  const allowedCandidates: ScheduledWorkflowCandidate[] = [];

  for (const candidate of candidates) {
    const source = sourceByWorkflowId.get(candidate.workflowId);
    if (!source) continue;
    if (await passesScheduledRunGuards(db, source, candidate)) {
      allowedCandidates.push(candidate);
    }
  }

  return allowedCandidates;
}
