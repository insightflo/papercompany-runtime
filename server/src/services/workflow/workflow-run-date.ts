/**
 * Workflow run date formatter.
 *
 * [extract] engine.ts 내부 헬퍼를 byte-for-byte 이동해 export한 것. 동작 변화 없음.
 * 엔진뿐 아니라 다른 호출자도 같은 날짜 키 규칙(runDate = timezone 기준 YYYY-MM-DD)을
 * 재사용할 수 있게 한다.
 */

export function formatDateKeyInTimezone(date: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}
