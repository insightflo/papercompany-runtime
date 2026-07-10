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
  type DirectWebProviderOutput,
  type DirectWebProviderRequest,
} from "./direct-web-provider.js";
import {
  McpProtocolError,
  parseJsonRpcEnvelope,
  type JsonRpcEnvelope,
} from "./mcp-json-rpc.js";
import { parsePublicResultUrl } from "./public-result-url.js";

export const EXA_MCP_BASE_URL = "https://mcp.exa.ai/mcp";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const JSON_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  [DIRECT_WEB_RESPONSE_LIMIT_HEADER]: String(MAX_DIRECT_WEB_RESPONSE_BYTES),
} as const;

export async function searchExaMcp(request: DirectWebProviderRequest): Promise<DirectWebProviderOutput> {
  const deadline = Date.now() + request.timeoutMs;

  try {
    const initialized = await postMcp(request.http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "papercompany-research-workbench",
          version: "0.1.0",
        },
      },
    }, deadline);

    if (!initialized.ok) return initialized.failure;

    const sessionId = initialized.response.headers.get("mcp-session-id");
    if (!sessionId) {
      return protocolFailure("Exa MCP initialize response omitted mcp-session-id");
    }

    const initializeEnvelope = await parseJsonRpcEnvelope(initialized.response, 1);
    const initializeError = getEnvelopeError(initializeEnvelope);
    if (initializeError) return protocolFailure(`Exa MCP initialize failed: ${initializeError}`);

    const upstreamVersion = readServerVersion(initializeEnvelope.result);
    const sessionHeaders = {
      ...JSON_HEADERS,
      "Mcp-Session-Id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };

    const notification = await fetchWithDeadline(request.http, EXA_MCP_BASE_URL, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }, deadline);
    if (!notification.ok) {
      return httpFailure("Exa MCP initialized notification", notification);
    }

    const called = await postMcp(request.http, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: request.query,
          numResults: request.maxResults,
        },
      },
    }, deadline, sessionHeaders);

    if (!called.ok) return called.failure;

    const callEnvelope = await parseJsonRpcEnvelope(called.response, 2);
    const callError = getEnvelopeError(callEnvelope);
    if (callError) return protocolFailure(`Exa MCP search failed: ${callError}`);

    const text = readTextContent(callEnvelope.result);
    const results = parseExaSearchText(text, request.maxResults);
    if (results.length === 0) {
      return {
        ok: false,
        error: "Exa MCP returned no parseable search results",
        reason: "empty_results",
        retryable: true,
      };
    }

    return {
      ok: true,
      results,
      ...(upstreamVersion ? { upstreamVersion } : {}),
    };
  } catch (error) {
    if (error instanceof McpProtocolError) {
      return protocolFailure(`Exa MCP protocol error: ${error.message}`);
    }
    if (error instanceof DirectWebResponseLimitError) {
      return {
        ok: false,
        error: error.message,
        reason: "response_too_large",
        retryable: true,
      };
    }
    if (error instanceof DirectWebTimeoutError || isAbortError(error)) {
      return {
        ok: false,
        error: `Exa MCP timed out after ${request.timeoutMs}ms`,
        reason: "timeout",
        retryable: true,
      };
    }
    return {
      ok: false,
      error: `Exa MCP network error: ${error instanceof Error ? error.message : String(error)}`,
      reason: "network_error",
      retryable: true,
    };
  }
}

async function postMcp(
  http: DirectWebProviderRequest["http"],
  payload: Record<string, unknown>,
  deadline: number,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<
  | { ok: true; response: Response }
  | { ok: false; failure: Extract<DirectWebProviderOutput, { ok: false }> }
> {
  const response = await fetchWithDeadline(http, EXA_MCP_BASE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, deadline);

  if (!response.ok) {
    return { ok: false, failure: httpFailure("Exa MCP request", response) };
  }
  return { ok: true, response };
}

function httpFailure(label: string, response: Response): Extract<DirectWebProviderOutput, { ok: false }> {
  const retryable = isRetryableHttpStatus(response.status);
  const retryAfterSeconds = parseRetryAfterSeconds(response);
  return {
    ok: false,
    error: `HTTP ${response.status} from ${label}`,
    reason: response.status === 401 || response.status === 403 ? "auth_required" : "http_error",
    retryable,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function protocolFailure(error: string): Extract<DirectWebProviderOutput, { ok: false }> {
  return {
    ok: false,
    error,
    reason: "protocol_error",
    retryable: true,
  };
}

function getEnvelopeError(envelope: JsonRpcEnvelope): string | null {
  if (!envelope.error) return null;
  const code = typeof envelope.error.code === "number" ? ` (${envelope.error.code})` : "";
  return `${envelope.error.message ?? "unknown JSON-RPC error"}${code}`;
}

function readServerVersion(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.serverInfo)) return undefined;
  return typeof result.serverInfo.version === "string" ? result.serverInfo.version : undefined;
}

function readTextContent(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const texts: string[] = [];
  for (const item of result.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    }
  }
  return texts.join("\n");
}

function parseExaSearchText(text: string, maxResults: number): VaneHeadlessSearchResult[] {
  const results: VaneHeadlessSearchResult[] = [];
  for (const block of text.split(/\n\s*---\s*\n/g)) {
    const title = matchField(block, "Title");
    const url = parsePublicResultUrl(matchField(block, "URL"));
    if (!title || !url) continue;

    const published = matchField(block, "Published");
    const highlights = block.match(/^Highlights:\s*\n([\s\S]*)$/m)?.[1] ?? "";
    results.push({
      title,
      url,
      snippet: collapseWhitespace(highlights),
      source: "exa-mcp",
      publishedAt: published && published.toUpperCase() !== "N/A" ? published : null,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

function matchField(block: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
