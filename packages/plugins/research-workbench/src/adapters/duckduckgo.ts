import type { VaneHeadlessSearchResult } from "../types.js";
import {
  DirectWebResponseLimitError,
  DirectWebTimeoutError,
  DIRECT_WEB_RESPONSE_LIMIT_HEADER,
  MAX_DIRECT_WEB_RESPONSE_BYTES,
  fetchWithDeadline,
  isAbortError,
  isRetryableHttpStatus,
  parseRetryAfterSeconds,
  readBoundedResponseText,
  type DirectWebProviderOutput,
  type DirectWebProviderRequest,
} from "./direct-web-provider.js";
import { parsePublicResultUrl } from "./public-result-url.js";

export const DUCKDUCKGO_BASE_URL = "https://lite.duckduckgo.com/lite/";
const DUCKDUCKGO_HTML_BASE_URL = "https://duckduckgo.com/html/";

const MAX_DUCKDUCKGO_REDIRECTS = 3;
const DIRECT_WEB_USER_AGENT = "Mozilla/5.0 (compatible; PaperclipResearchWorkbench/0.1; +https://papercompany.showk.ing)";
const DIRECT_WEB_HEADERS = {
  "User-Agent": DIRECT_WEB_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  [DIRECT_WEB_RESPONSE_LIMIT_HEADER]: String(MAX_DIRECT_WEB_RESPONSE_BYTES),
} as const;

export async function searchDuckDuckGo(request: DirectWebProviderRequest): Promise<DirectWebProviderOutput> {
  const surfaces = [
    { name: "DuckDuckGo lite", baseUrl: DUCKDUCKGO_BASE_URL },
    { name: "DuckDuckGo html", baseUrl: DUCKDUCKGO_HTML_BASE_URL },
  ];
  const failures: string[] = [];
  let retryAfterSeconds: number | undefined;
  let failureReason: Extract<DirectWebProviderOutput, { ok: false }>["reason"] = "empty_results";

  for (const surface of surfaces) {
    let url = `${surface.baseUrl}?${new URLSearchParams({ q: request.query }).toString()}`;
    const deadline = Date.now() + request.timeoutMs;
    try {
      for (let redirectCount = 0; redirectCount <= MAX_DUCKDUCKGO_REDIRECTS; redirectCount += 1) {
        const response = await fetchWithDeadline(request.http, url, {
          method: "GET",
          headers: DIRECT_WEB_HEADERS,
          redirect: "manual",
        }, deadline);

        if (isRedirectStatus(response.status)) {
          const redirectUrl = resolveDuckDuckGoRedirect(url, response.headers.get("location"));
          if (!redirectUrl) {
            failures.push(`${surface.name}: refused unexpected redirect`);
            failureReason = "protocol_error";
            break;
          }
          if (redirectCount === MAX_DUCKDUCKGO_REDIRECTS) {
            failures.push(`${surface.name}: exceeded ${MAX_DUCKDUCKGO_REDIRECTS} redirects`);
            failureReason = "protocol_error";
            break;
          }
          url = redirectUrl;
          continue;
        }

        if (!response.ok) {
          const retryable = isRetryableHttpStatus(response.status);
          retryAfterSeconds = parseRetryAfterSeconds(response) ?? retryAfterSeconds;
          const message = `HTTP ${response.status} from ${surface.name}`;
          failures.push(message);
          failureReason = response.status === 401 || response.status === 403 ? "auth_required" : "http_error";
          if (!retryable) {
            return {
              ok: false,
              error: message,
              reason: failureReason,
              retryable: false,
            };
          }
          break;
        }

        const html = await readBoundedResponseText(response);
        const results = parseDuckDuckGoResults(html, request.maxResults);
        if (results.length > 0) {
          return { ok: true, results };
        }

        failures.push(describeEmptySearchPage(surface.name, response.status, html));
        failureReason = "empty_results";
        break;
      }
    } catch (error) {
      if (error instanceof DirectWebResponseLimitError) {
        failures.push(`${surface.name}: ${error.message}`);
        failureReason = "response_too_large";
      } else if (error instanceof DirectWebTimeoutError || isAbortError(error)) {
        failures.push(`${surface.name}: timed out after ${request.timeoutMs}ms`);
        failureReason = "timeout";
      } else {
        failures.push(`${surface.name}: ${error instanceof Error ? error.message : "direct-web fetch failed"}`);
        failureReason = "network_error";
      }
    }
  }

  return {
    ok: false,
    error: `DuckDuckGo returned no parseable results (${failures.join("; ")})`,
    reason: failureReason,
    retryable: true,
    retryAfterSeconds: retryAfterSeconds ?? 60,
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveDuckDuckGoRedirect(currentUrl: string, location: string | null): string | null {
  if (!location) return null;

  try {
    const target = new URL(location, currentUrl);
    const hostname = target.hostname.toLowerCase();
    if (target.protocol !== "https:" || (hostname !== "duckduckgo.com" && !hostname.endsWith(".duckduckgo.com"))) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}

const TOKEN_RE = /<a\b[^>]*(?:result-link|result__a)[^>]*>[\s\S]*?<\/a>|<(?:td|a|div)\b[^>]*(?:result-snippet|result__snippet)[^>]*>[\s\S]*?<\/(?:td|a|div)>/gi;

function parseDuckDuckGoResults(html: string, maxResults: number): VaneHeadlessSearchResult[] {
  const results: VaneHeadlessSearchResult[] = [];
  let pending: { url: string; title: string } | null = null;
  const re = new RegExp(TOKEN_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const token = match[0];
    if (/(?:result-link|result__a)/i.test(token)) {
      if (pending) {
        results.push({ url: pending.url, title: pending.title, snippet: "", source: "duckduckgo" });
        pending = null;
        if (results.length >= maxResults) break;
      }
      const href = extractHref(token);
      const url = resolveResultUrl(href);
      if (!url) {
        pending = null;
        continue;
      }
      const inner = token.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
      pending = { url, title: cleanText(inner) };
    } else {
      const inner = token.match(/<(?:td|a|div)\b[^>]*>([\s\S]*?)<\/(?:td|a|div)>/i)?.[1] ?? "";
      const snippet = cleanText(inner);
      if (pending) {
        results.push({ url: pending.url, title: pending.title, snippet, source: "duckduckgo" });
        pending = null;
        if (results.length >= maxResults) break;
      }
    }
  }
  if (pending && results.length < maxResults) {
    results.push({ url: pending.url, title: pending.title, snippet: "", source: "duckduckgo" });
  }
  return results;
}

function extractHref(anchorHtml: string): string {
  const match = anchorHtml.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return match?.[1] ?? match?.[2] ?? "";
}

function resolveResultUrl(href: string): string | null {
  const value = href.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return parsePublicResultUrl(value);
  if (value.includes("uddg=")) {
    let parsedTarget: string | null = null;
    try {
      parsedTarget = new URL(value, DUCKDUCKGO_BASE_URL).searchParams.get("uddg");
    } catch {
      parsedTarget = null;
    }
    if (parsedTarget && /^https?:\/\//i.test(parsedTarget)) return parsePublicResultUrl(parsedTarget);
    const encoded = value.match(/uddg=([^&]+)/)?.[1];
    if (encoded) {
      try {
        const target = decodeURIComponent(encoded);
        return /^https?:\/\//i.test(target) ? parsePublicResultUrl(target) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cleanText(html: string): string {
  return collapseWhitespace(decodeEntities(stripTags(html)));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeEmptySearchPage(name: string, status: number, html: string): string {
  const hasKnownMarkers = /result-link|result-snippet|result__a|result__snippet/i.test(html);
  if (status === 202) {
    return `${name}: HTTP 202 challenge/accepted page without parseable results`;
  }
  if (/anomaly|captcha|verify you are human|challenge-form|bot detection/i.test(html) && !hasKnownMarkers) {
    return `${name}: challenge page without parseable results`;
  }
  if (/No results/i.test(html)) {
    return `${name}: no results page`;
  }
  return hasKnownMarkers
    ? `${name}: result markers were present but no valid result URLs were parsed`
    : `${name}: no result markers found`;
}
