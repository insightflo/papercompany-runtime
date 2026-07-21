// server/src/services/missions/utils.ts
//
// [파일 목적] mission governance에서 쓰이는 순수 leaf helper(casting/날짜 파싱) 모음.
//   missions.ts(4100+줄) mega-file 회피를 위해 분리. db 접근·클로저 의존 없는 pure function만 둔다.
// [수정시 주의] side-effect/db/agent-state 접근 금지. 입력→출력 순수 함수만 유지할 것.
// [외부 연결] consumer: missions.ts (import). 다른 모듈은 missions.ts 경유 또는 직접 import 가능.
import { badRequest } from "../../errors.js";

/** 객체(배열 제외) 여부 타입 가드. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 비어있지 않은 trimmed 문자열, 또는 null. */
export function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 문자열 배열로 캐스팅(빈 문자열/비문자열 제거). */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** record 배열로 캐스팅. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

/** plugin 원본 값을 Date로 파싱(실패 시 null). */
export function parsePluginDate(value: unknown): Date | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

const MISSION_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isMissionDateOnlyFilter(value: string): boolean {
  return MISSION_DATE_ONLY_PATTERN.test(value.trim());
}

function missionTimeZoneOffsetMilliseconds(instant: Date, formatter: Intl.DateTimeFormat): number {
  const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
    instant.getUTCMilliseconds(),
  ) - instant.getTime();
}

function missionDateBoundaryInTimeZone(
  year: number,
  month: number,
  day: number,
  boundary: "start" | "end",
  timeZone: string,
): Date {
  const localDate = new Date(Date.UTC(year, month, day + (boundary === "end" ? 1 : 0)));
  const intendedUtcTimestamp = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
  );

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    let instant = new Date(intendedUtcTimestamp);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      instant = new Date(intendedUtcTimestamp - missionTimeZoneOffsetMilliseconds(instant, formatter));
    }
    return instant;
  } catch {
    throw badRequest(`Invalid mission date filter timezone: ${timeZone}`);
  }
}

/** Converts YYYY-MM-DD to a local-day start/end-exclusive boundary in the company timezone, or parses an ISO instant. */
export function parseMissionDateFilter(value: string, boundary: "start" | "end", timeZone = "UTC"): Date {
  const normalized = value.trim();
  const dateOnlyMatch = MISSION_DATE_ONLY_PATTERN.exec(normalized);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return missionDateBoundaryInTimeZone(
      Number(year),
      Number(month) - 1,
      Number(day),
      boundary,
      timeZone,
    );
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`Invalid mission date filter: ${value}`);
  }
  return new Date(parsed);
}
