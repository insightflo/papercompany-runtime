import type {
  DirectWebProviderAttempt,
  DirectWebProviderName,
  ResearchSearchInput,
  VaneHeadlessSearchOutput,
  VaneHeadlessSearchResult,
} from "../types.js";
import type {
  DirectWebHttp,
  DirectWebProviderOutput,
} from "./direct-web-provider.js";
import { DUCKDUCKGO_BASE_URL, searchDuckDuckGo } from "./duckduckgo.js";
import { EXA_MCP_BASE_URL, searchExaMcp } from "./exa-mcp.js";

export { type DirectWebHttp } from "./direct-web-provider.js";

export const DIRECT_WEB_BASE_URL = EXA_MCP_BASE_URL;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS_CAP = 25;
const MAX_RESULT_TITLE_CHARACTERS = 300;
const MAX_RESULT_SNIPPET_CHARACTERS = 1200;
const DEFAULT_PROVIDERS: readonly DirectWebProviderName[] = ["exa-mcp", "duckduckgo"];

export interface DirectWebAdapterOptions {
  http?: DirectWebHttp;
  timeoutMs?: number;
  providers?: readonly DirectWebProviderName[];
}

export interface DirectWebSearchInput extends ResearchSearchInput {
  maxResults: number;
}

export interface DirectWebAdapter {
  search(input: DirectWebSearchInput): Promise<VaneHeadlessSearchOutput>;
}

export function createDirectWebAdapter(options: DirectWebAdapterOptions = {}): DirectWebAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const fetchImpl: DirectWebHttp["fetch"] = options.http
    ? options.http.fetch.bind(options.http)
    : globalThis.fetch.bind(globalThis);
  const http: DirectWebHttp = { fetch: fetchImpl };

  async function search(input: DirectWebSearchInput): Promise<VaneHeadlessSearchOutput> {
    const query = input.query.trim();
    const maxResults = Math.min(MAX_RESULTS_CAP, Math.max(1, input.maxResults));
    const retrievedAt = new Date().toISOString();
    const attempts: DirectWebProviderAttempt[] = [];
    const failures: string[] = [];
    let retryable = false;
    let retryAfterSeconds: number | undefined;

    for (const provider of providers) {
      const output = await runProvider(provider, { http, timeoutMs, query, maxResults });
      if (output.ok) {
        attempts.push({ provider, status: "ok" });
        return {
          ok: true,
          query,
          results: normalizeProviderResults(output.results),
          engine: {
            name: "direct-web",
            provider,
            attempts,
            ...(output.upstreamVersion ? { upstreamVersion: output.upstreamVersion } : {}),
          },
          retrievedAt,
        };
      }

      attempts.push({
        provider,
        status: "error",
        reason: output.reason,
        detail: output.error,
      });
      failures.push(`${provider}: ${output.error}`);
      retryable ||= output.retryable;
      retryAfterSeconds ??= output.retryAfterSeconds;
    }

    return {
      ok: false,
      error: `direct-web providers exhausted (${failures.join("; ")})`,
      retryable,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      engine: { name: "direct-web", attempts },
      retrievedAt,
    };
  }

  return { search };
}

function normalizeProviderResults(results: VaneHeadlessSearchResult[]): VaneHeadlessSearchResult[] {
  return results.map((result) => ({
    ...result,
    title: truncateText(result.title, MAX_RESULT_TITLE_CHARACTERS),
    snippet: truncateText(result.snippet, MAX_RESULT_SNIPPET_CHARACTERS),
  }));
}

function truncateText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, maxCharacters - 3).trimEnd()}...`;
}

export function getDirectWebProviderBaseUrl(provider?: DirectWebProviderName): string {
  return provider === "duckduckgo" ? DUCKDUCKGO_BASE_URL : EXA_MCP_BASE_URL;
}

function runProvider(
  provider: DirectWebProviderName,
  request: Parameters<typeof searchExaMcp>[0],
): Promise<DirectWebProviderOutput> {
  return provider === "exa-mcp"
    ? searchExaMcp(request)
    : searchDuckDuckGo(request);
}
