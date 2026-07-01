// server/src/services/public-url-readback.ts
//
// [파일 목적] ACTION publish 단계가 preview_url workProduct 로 등록한 공개 URL 이
//   실제 콘텐츠(detail) 인지 hub shell 인지 검증(readback) 한다. HTTP 200 만으로
//   완료 처리되는 b0f20b55 사례(온보딩 허브 셸이 detail workProduct 로 둔갑)를 막기 위함.
// [주요 흐름] readbackPublicUrl(url) → SSRF 안전 fetch(프로토콜 화이트리스트 + private IP 차단 +
//   타임아웃) → {status, text}. 순수 함수 isManualOnboardingHubShell / extractExpectedContentMarker
//   로 hub shell 판별 + 기대 content marker 존재 여부 판정.
// [외부 연결] issues.ts assertDeliveryReadbackBeforeDone 가 완료 게이트에서 호출.
// [수정시 주의] fetcher 는 테스트에서 setPublicUrlReadbackFetcher 로 교체 가능.
//   SSRF 심화(DNS-rebind IP pinning)는 plugin-host-services.validateAndResolveFetchUrl 가 담당하며,
//   본 유틸은 resolved IP 사전 검사 + private 차단까지만 한다(서버 사이드 완료 게이트용 충분한 기준선).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface PublicUrlReadback {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

const READBACK_TIMEOUT_MS = 8_000;
const DNS_TIMEOUT_MS = 3_000;

let readbackFetcher: (url: string) => Promise<PublicUrlReadback> = defaultReadbackPublicUrl;

/** 테스트 주입용 fetcher 교체. null 이면 기본 SSRF-safe fetch 복원. */
export function setPublicUrlReadbackFetcher(fn: ((url: string) => Promise<PublicUrlReadback>) | null): void {
  readbackFetcher = fn ?? defaultReadbackPublicUrl;
}

/** 완료 게이트에서 호출: 공개 URL readback. fetcher 는 주입 가능. */
export async function readbackPublicUrl(url: string): Promise<PublicUrlReadback> {
  return readbackFetcher(url);
}

// manual-onboarding hub shell 판별. detail 페이지가 아니라 허브 index/셸이면 true.
const HUB_SHELL_TITLE_RE = /<title>\s*온보딩\s*라이브러리\s*<\/title>/iu;
export function isManualOnboardingHubShell(text: string): boolean {
  return HUB_SHELL_TITLE_RE.test(text);
}

/**
 * [목적] 구조화된 workProduct 제목에서 readback 에서 찾아야 할 content marker 추출.
 *   제목이 "파인만 방법론 v2: 온보딩 개념" 형태면 colon 앞 "파인만 방법론 v2" 를 marker 로 쓴다.
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, text: "", error: "Invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, status: 0, text: "", error: `Disallowed protocol ${parsed.protocol}` };
  }
  // SSRF: hostname 이 IP literal 이면 private/loopback 차단. DNS 이름은 resolve 후 검사.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIPLiteralPrivate(hostname)) {
    return { ok: false, status: 0, text: "", error: `Blocked private/loopback host ${hostname}` };
  }
  const dnsOk = await resolvedAddressesArePublic(hostname).catch(() => false);
  if (!dnsOk) {
    return { ok: false, status: 0, text: "", error: `Resolved address for ${hostname} is private or unresolvable` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READBACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function isIPLiteralPrivate(host: string): boolean {
  if (isIP(host) === 0) return false;
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  const v4 = host.split(".").map((octet) => Number.parseInt(octet, 10));
  if (v4.length === 4 && v4.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [a, b] = v4;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a >= 224) return true; // multicast/reserved
  }
  return false;
}

async function resolvedAddressesArePublic(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return true; // literal 은 위에서 이미 검사
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS);
  });
  const results = await Promise.race([dnsLookup(hostname, { all: true }), timer]).catch(() => [] as Array<{ address: string }>);
  if (results.length === 0) return false;
  return results.every((entry) => !isIPLiteralPrivate(entry.address));
}
