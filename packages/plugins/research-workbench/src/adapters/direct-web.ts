import type {
  ResearchSearchInput,
  VaneHeadlessSearchOutput,
  VaneHeadlessSearchResult,
} from "../types.js";

export const DIRECT_WEB_BASE_URL = "https://lite.duckduckgo.com/lite/";
const DIRECT_WEB_HTML_BASE_URL = "https://duckduckgo.com/html/";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS_CAP = 25;
const DIRECT_WEB_USER_AGENT = "Mozilla/5.0 (compatible; PaperclipResearchWorkbench/0.1; +https://papercompany.showk.ing)";
const DIRECT_WEB_HEADERS = {
  "User-Agent": DIRECT_WEB_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
} as const;

export interface DirectWebHttp {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DirectWebAdapterOptions {
  /** HTTP surface with a fetch method. Defaults to global fetch when omitted. */
  http?: DirectWebHttp;
  /** Per-request timeout. The adapter always passes an AbortSignal. */
  timeoutMs?: number;
}

export interface DirectWebSearchInput extends ResearchSearchInput {
  maxResults: number;
}

export interface DirectWebAdapter {
  search(input: DirectWebSearchInput): Promise<VaneHeadlessSearchOutput>;
}

export function createDirectWebAdapter(options: DirectWebAdapterOptions = {}): DirectWebAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: DirectWebHttp["fetch"] = options.http
    ? options.http.fetch.bind(options.http)
    : globalThis.fetch.bind(globalThis);

  async function search(input: DirectWebSearchInput): Promise<VaneHeadlessSearchOutput> {
    const query = input.query.trim();
    const maxResults = Math.min(MAX_RESULTS_CAP, Math.max(1, input.maxResults));
    const retrievedAt = new Date().toISOString();
    const engine = { name: "direct-web" as const };

    const attempts = [
      { name: "DuckDuckGo lite", baseUrl: DIRECT_WEB_BASE_URL },
      { name: "DuckDuckGo html", baseUrl: DIRECT_WEB_HTML_BASE_URL },
    ];
    const failures: string[] = [];
    let retryAfterSeconds: number | undefined;

    for (const attempt of attempts) {
      const url = `${attempt.baseUrl}?${new URLSearchParams({ q: query }).toString()}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: DIRECT_WEB_HEADERS,
          signal: controller.signal,
        });

        if (!response.ok) {
          const status = response.status;
          const retryable = status >= 500 || status === 429 || status === 202;
          if (retryable) {
            const retryAfter = response.headers.get("Retry-After");
            const parsed = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
            retryAfterSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : retryAfterSeconds ?? 60;
          }
          const message = `HTTP ${status} from ${attempt.name}`;
          failures.push(message);
          if (!retryable) {
            return {
              ok: false,
              error: message,
              retryable,
              engine,
              retrievedAt,
            };
          }
          continue;
        }

        const html = await response.text();
        const results = parseDuckDuckGoResults(html, maxResults);
        if (results.length > 0) {
          return {
            ok: true,
            query,
            results,
            engine,
            retrievedAt,
          };
        }

        failures.push(describeEmptySearchPage(attempt.name, response.status, html));
      } catch (err) {
        failures.push(`${attempt.name}: ${err instanceof Error ? err.message : "direct-web fetch failed"}`);
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      error: `DuckDuckGo returned no parseable results (${failures.join("; ")})`,
      retryable: true,
      retryAfterSeconds: retryAfterSeconds ?? 60,
      engine,
      retrievedAt,
    };
  }

  return { search };
}

// ---------------------------------------------------------------------------
// Minimal, defensive DuckDuckGo lite/html parsing
// ---------------------------------------------------------------------------

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
        results.push({ url: pending.url, title: pending.title, snippet: "" });
        pending = null;
        if (results.length >= maxResults) break;
      }
      const href = extractHref(token);
      const url = resolveResultUrl(href);
      if (!url) {
        // Invalid href (e.g. javascript:) — drop any pending pair and move on.
        pending = null;
        continue;
      }
      const inner = token.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
      pending = { url, title: cleanText(inner) };
    } else {
      const inner = token.match(/<(?:td|a|div)\b[^>]*>([\s\S]*?)<\/(?:td|a|div)>/i)?.[1] ?? "";
      const snippet = cleanText(inner);
      if (pending) {
        results.push({ url: pending.url, title: pending.title, snippet });
        pending = null;
        if (results.length >= maxResults) break;
      }
    }
  }
  if (pending && results.length < maxResults) {
    results.push({ url: pending.url, title: pending.title, snippet: "" });
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
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes("uddg=")) {
    try {
      const parsed = new URL(value, DIRECT_WEB_BASE_URL);
      const target = parsed.searchParams.get("uddg");
      if (target && /^https?:\/\//i.test(target)) return target;
    } catch {
      // fall through to regex extraction
    }
    const encoded = value.match(/uddg=([^&]+)/)?.[1];
    if (encoded) {
      try {
        const target = decodeURIComponent(encoded);
        return /^https?:\/\//i.test(target) ? target : null;
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
