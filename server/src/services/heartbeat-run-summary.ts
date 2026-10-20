function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// [저장 상한 2026-10-20 승인] 실행 출력 원문은 run-log 파일(logStore/logRef)에만 두고
//   DB result_json 에는 앞/뒤 32KB 만 보관한다. heartbeat_runs 가 4개월에 7GB(행당 평균 ~215KB,
//   stdout이 95%+)로 자란 원인 차단 — 요약·usage·구조 필드는 그대로 둔다.
//   임계값(70,000)은 절삭 본문(65,536+마커)보다 커서 재절삭되지 않는다.
const STORED_OUTPUT_CAP_CHARS_PER_SIDE = 32 * 1024;
const STORED_OUTPUT_TRUNCATE_THRESHOLD_CHARS = 70_000;
const STORED_OUTPUT_TEXT_KEYS = ["stdout", "stderr"] as const;

export function capHeartbeatRunResultJsonForStorage(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return resultJson ?? null;
  }
  let capped: Record<string, unknown> | null = null;
  for (const key of STORED_OUTPUT_TEXT_KEYS) {
    const value = resultJson[key];
    if (typeof value !== "string" || value.length <= STORED_OUTPUT_TRUNCATE_THRESHOLD_CHARS) continue;
    if (!capped) capped = { ...resultJson };
    const omitted = value.length - (STORED_OUTPUT_CAP_CHARS_PER_SIDE * 2);
    capped[key] =
      value.slice(0, STORED_OUTPUT_CAP_CHARS_PER_SIDE)
      + `\n...[truncated ${omitted} chars; full output in run log file]...\n`
      + value.slice(-STORED_OUTPUT_CAP_CHARS_PER_SIDE);
  }
  return capped ?? resultJson;
}
