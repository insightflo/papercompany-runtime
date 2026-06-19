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

/** mission date 필터(YYYY-MM-DD 또는 ISO)를 boundary(start=00:00:00 / end=23:59:59) Date로 변환. */
export function parseMissionDateFilter(value: string, boundary: "start" | "end"): Date {
  const normalized = value.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999,
    );
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`Invalid mission date filter: ${value}`);
  }
  return new Date(parsed);
}
