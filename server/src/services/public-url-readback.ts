// Public URL readback with explicitly declared, literal title rejection rules.
// Pinned public HTTPS transport; no provider or domain-specific defaults.
import { requestPublicHttps } from "./public-https-request.js";

export interface PublicUrlReadback {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

let readbackFetcher: (url: string) => Promise<PublicUrlReadback> = defaultReadbackPublicUrl;

/** 테스트 주입용 fetcher 교체. null 이면 기본 SSRF-safe fetch 복원. */
export function setPublicUrlReadbackFetcher(fn: ((url: string) => Promise<PublicUrlReadback>) | null): void {
  readbackFetcher = fn ?? defaultReadbackPublicUrl;
}

/** 완료 게이트에서 호출: 공개 URL readback. fetcher 는 주입 가능. */
export type PublicReadbackRules = { rejectTitlePatterns: readonly string[] };
export async function readbackPublicUrl(url: string, rules?: PublicReadbackRules): Promise<PublicUrlReadback> {
  const result = await readbackFetcher(url);
  return result.ok && isRejectedPublicTitle(result.text, rules)
    ? { ...result, ok: false, error: 'public_readback_title_rejected' } : result;
}

/** Plain strings, not regex programs. Match title only; ignore case and whitespace. */
export function isRejectedPublicTitle(text: string, rules?: PublicReadbackRules): boolean {
  const normalize = (value: string) => value.replace(/\s+/gu, '').toLowerCase();
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(text)?.[1];
  return title !== undefined && (rules?.rejectTitlePatterns ?? []).some(pattern => normalize(title) === normalize(pattern));
}

/**
 * [목적] 구조화된 workProduct 제목에서 readback 에서 찾아야 할 content marker 추출.
 *   제목이 "Document v2: Overview" 형태면 colon 앞 "Document v2" 를 marker 로 쓴다.
 *   colon 이 없으면 제목 전체(의미 토큰)를 marker 로 쓴다. 빈 문자열이면 marker 없음(판정 불가).
 */
export function extractExpectedContentMarker(title: string | null | undefined): string {
  if (!title) return "";
  const idx = title.indexOf(":");
  const head = idx >= 0 ? title.slice(0, idx) : title;
  // 앞쪽 잡음(앞번호/괄호 접두/특수문자) 을 덜어내고 의미 토큰만 남긴다.
  const cleaned = head.replace(/^[^A-Za-z0-9가-힣]+/u, "").trim();
  return cleaned;
}

/** readback 본문이 기대 marker 를 포함하는지. marker 가 비었으면 검증 불가 → false. */
export function readbackBodyContainsMarker(readback: PublicUrlReadback, marker: string): boolean {
  const token = marker.trim();
  if (!token) return false;
  return readback.text.includes(token);
}

async function defaultReadbackPublicUrl(url: string): Promise<PublicUrlReadback> {
  return requestPublicHttps(url);
}
