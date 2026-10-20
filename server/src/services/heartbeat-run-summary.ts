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

// [경계 안전 2026-10-20] JS slice 는 UTF-16 코드 유닛 단위라 서로게이트 페어(이모지)를
//   한가운데 잘라 고립 서로게이트를 만들 수 있고, 그 문자열을 담은 JSON 을 PostgreSQL 가
//   "invalid input syntax for json ... surrogate" 오류로 거부해 실행 정산 저장이 실패한다(실측).
//   경계가 상위 서로게이트로 끝나거나 하위로 시작하면 한 코드 유닛 안쪽으로 물러나
//   항상 유효한 유니코드 문자열만 만든다.
function capOutputText(value: string): string {
  let headEnd = Math.min(STORED_OUTPUT_CAP_CHARS_PER_SIDE, value.length);
  if (headEnd > 0) {
    const last = value.charCodeAt(headEnd - 1);
    if (last >= 0xd800 && last <= 0xdbff) headEnd -= 1;
  }
  let tailStart = Math.max(value.length - STORED_OUTPUT_CAP_CHARS_PER_SIDE, 0);
  if (tailStart < value.length) {
    const first = value.charCodeAt(tailStart);
    if (first >= 0xdc00 && first <= 0xdfff) tailStart += 1;
  }
  const head = value.slice(0, headEnd);
  const tail = value.slice(tailStart);
  const omitted = value.length - headEnd - (value.length - tailStart);
  return head
    + `\n...[truncated ${omitted} chars; full output in run log file]...\n`
    + tail;
}

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
    capped[key] = capOutputText(value);
  }
  return capped ?? resultJson;
}
