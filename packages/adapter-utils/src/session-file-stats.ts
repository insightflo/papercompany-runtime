import fs from "node:fs/promises";
import path from "node:path";

/** 세션 파일 통계를 위한 안전 상한 — 이보다 큰 파일은 읽지 않고 null을 반환한다. */
const MAX_SESSION_FILE_BYTES = 20 * 1024 * 1024;

/**
 * [session hygiene] pi 계열 어댑터의 sessionId는 세션 JSONL 파일 경로다.
 *   최상위 type==="message" 엔트리 수(≈ 대화 메시지 수)를 센다.
 *   파일이 아니거나 읽을 수 없으면 null (해당 어댑터는 이 트리거에서 제외).
 */
export async function countSessionFileMessages(sessionId: string | null | undefined): Promise<number | null> {
  const value = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!value || !path.isAbsolute(value) || !value.endsWith(".jsonl")) return null;
  let stat;
  try {
    stat = await fs.stat(value);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return 0;
  if (stat.size > MAX_SESSION_FILE_BYTES) return null;
  let content: string;
  try {
    content = await fs.readFile(value, "utf8");
  } catch {
    return null;
  }
  let count = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry: unknown = JSON.parse(trimmed);
      if (
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
        && (entry as { type?: unknown }).type === "message"
      ) {
        count += 1;
      }
    } catch {
      // malformed line — 개수에 반영하지 않고 건너뛴다
    }
  }
  return count;
}
