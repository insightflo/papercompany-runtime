import type {
  VaneHeadlessSearchOutput,
  VaneHeadlessSearchResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface VaneNonRetryableError {
  ok: false;
  retryable: false;
  error: string;
  status?: number;
}

export interface VaneRetryableError {
  ok: false;
  retryable: true;
  error: string;
  retryAfterSeconds: number;
}

export type VaneAdapterError = VaneNonRetryableError | VaneRetryableError;

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: VaneHeadlessSearchOutput;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Cache TTL (ms) — 60 seconds to reduce accidental agent-loop hammering
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Default timeout — 30 000 ms
// ---------------------------------------------------------------------------

const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface VaneHeadlessAdapterOptions {
  vaneBaseUrl: string;
  timeoutMs?: number;
  /** Minimal HTTP client matching ctx.http.fetch signature */
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
}

// ---------------------------------------------------------------------------
// Adapter search input (subset of ResearchSearchInput)
// ---------------------------------------------------------------------------

export interface VaneHeadlessAdapterSearchInput {
  query: string;
  maxResults: number;
  profile?: string;
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Validate vaneBaseUrl
// ---------------------------------------------------------------------------

export function validateVaneBaseUrl(url: string): string | null {
  if (!url) return "vaneBaseUrl is required";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "vaneBaseUrl must be a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "vaneBaseUrl must use http or https protocol";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build cache key
// ---------------------------------------------------------------------------

function buildCacheKey(input: VaneHeadlessAdapterSearchInput): string {
  return JSON.stringify({
    query: input.query,
    profile: input.profile ?? "",
    categories: input.categories ?? [],
    maxResults: input.maxResults,
  });
}

// ---------------------------------------------------------------------------
// Create Vane Headless Adapter
// ---------------------------------------------------------------------------

export interface VaneHeadlessAdapter {
  search(input: VaneHeadlessAdapterSearchInput): Promise<VaneHeadlessSearchOutput>;
  clearCache(): void;
}

export function createVaneHeadlessAdapter(
  options: VaneHeadlessAdapterOptions,
): VaneHeadlessAdapter {
  const { vaneBaseUrl, http } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();

  // Validate URL at creation time
  const validationError = validateVaneBaseUrl(vaneBaseUrl);
  if (validationError) {
    throw new Error(validationError);
  }

  // Ensure no trailing slash for URL construction
  const baseUrl = vaneBaseUrl.replace(/\/+$/, "");

  async function search(
    input: VaneHeadlessAdapterSearchInput,
  ): Promise<VaneHeadlessSearchOutput> {
    const cacheKey = buildCacheKey(input);

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    // Build request body — only permitted fields
    const body: Record<string, unknown> = {
      query: input.query,
      maxResults: input.maxResults,
      profile: input.profile,
      categories: input.categories ?? ["general"],
    };

    const url = `${baseUrl}/api/papercompany/search/raw`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // HTTP 400 → non-retryable error
      if (response.status === 400) {
        let errorText: string;
        try {
          const errBody = await response.json();
          errorText =
            typeof errBody?.error === "string"
              ? errBody.error
              : `Bad request: ${response.status}`;
        } catch {
          errorText = `Bad request: ${response.status}`;
        }

        const result: VaneHeadlessSearchOutput = {
          ok: false,
          error: errorText,
          retryable: false,
          engine: { name: "vane-headless" },
          retrievedAt: new Date().toISOString(),
        };
        return result;
      }

      // HTTP 5xx → retryable error
      if (response.status >= 500) {
        const retryAfterHeader = response.headers.get("Retry-After");
        let retryAfterSeconds = 60;
        if (retryAfterHeader) {
          const parsed = Number(retryAfterHeader);
          if (Number.isFinite(parsed) && parsed > 0) {
            retryAfterSeconds = parsed;
          }
        }

        const result: VaneHeadlessSearchOutput = {
          ok: false,
          error: `Vane server error: HTTP ${response.status}`,
          retryable: true,
          engine: { name: "vane-headless" },
          retrievedAt: new Date().toISOString(),
        };

        // Attach retryAfterSeconds via the raw output for the worker
        (result as VaneHeadlessSearchOutput & { retryAfterSeconds?: number }).retryAfterSeconds =
          retryAfterSeconds;

        return result;
      }

      // Other non-ok statuses → non-retryable
      if (!response.ok) {
        const result: VaneHeadlessSearchOutput = {
          ok: false,
          error: `Unexpected HTTP status: ${response.status}`,
          retryable: false,
          engine: { name: "vane-headless" },
          retrievedAt: new Date().toISOString(),
        };
        return result;
      }

      // Success — parse JSON
      const json = (await response.json()) as {
        results?: VaneHeadlessSearchResult[];
        suggestions?: string[];
        engine?: { upstreamVersion?: string; patchVersion?: string };
      };

      const now = new Date().toISOString();
      const result: VaneHeadlessSearchOutput = {
        ok: true,
        query: input.query,
        results: Array.isArray(json.results) ? json.results : [],
        suggestions: json.suggestions,
        engine: {
          name: "vane-headless",
          upstreamVersion: json.engine?.upstreamVersion,
          patchVersion: json.engine?.patchVersion,
        },
        retrievedAt: now,
      };

      // Store in cache
      cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return result;
    } catch (err: unknown) {
      // Timeout / network errors → retryable
      const retryAfterSeconds = 60;
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? `Vane request timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? `Vane network error: ${err.message}`
            : `Vane unknown error: ${String(err)}`;

      const result: VaneHeadlessSearchOutput = {
        ok: false,
        error: message,
        retryable: true,
        engine: { name: "vane-headless" },
        retrievedAt: new Date().toISOString(),
      };

      // Attach retryAfterSeconds for the worker
      (result as VaneHeadlessSearchOutput & { retryAfterSeconds?: number }).retryAfterSeconds =
        retryAfterSeconds;

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function clearCache(): void {
    cache.clear();
  }

  return { search, clearCache };
}
