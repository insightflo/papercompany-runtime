import assert from "node:assert/strict";
import test from "node:test";

import { createDirectWebAdapter } from "../dist/adapters/direct-web.js";

function makeMockHttp(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("No more mock responses");
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "Content-Type": "text/html; charset=utf-8" },
  });
}

function sseResponse(payload, init = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...(init.headers ?? {}),
    },
  });
}

function sseEventsResponse(payloads, init = {}) {
  const body = payloads
    .map((payload) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...(init.headers ?? {}),
    },
  });
}

function multilineSseResponse(payload, splitAt, init = {}) {
  const serialized = JSON.stringify(payload);
  const body = `event: message\ndata: ${serialized.slice(0, splitAt)}\ndata: ${serialized.slice(splitAt)}\n\n`;
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...(init.headers ?? {}),
    },
  });
}

function exaSearchText() {
  return `Title: Internal-only result
URL: http://127.0.0.1/admin
Published: N/A
Author: N/A
Highlights:
This source must never enter a public evidence bundle.

---

Title: 2026 소상공인 지원사업 통합 공고
URL: https://www.bizinfo.go.kr/example/notice-1
Published: 2025-12-30
Author: 중소벤처기업부
Highlights:
${"2026년 소상공인 지원사업의 대상과 신청 절차를 안내합니다. ".repeat(50)}

---

Title: 2026년도 창업지원사업 통합공고
URL: https://www.k-startup.go.kr/example/notice-2
Published: N/A
Author: N/A
Highlights:
예비창업자와 창업기업을 위한 지원사업 공고입니다.`;
}

function liteHtml() {
  return `
    <html>
      <body>
        <a class="result-link" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fone">One &amp; Two</a>
        <td class="result-snippet">First <b>snippet</b> with &#x27;entity&#x27;</td>
        <a rel="nofollow" class="result-link" href="https://docs.example.com/two?utm_source=test">Two Result</a>
        <td class="result-snippet">Second snippet</td>
        <a class="result-link" href="javascript:void(0)">Ignored JavaScript</a>
        <td class="result-snippet">Ignored snippet</td>
        <a class="result-link" href="https://example.com/three">Three Result</a>
        <td class="result-snippet">Third snippet</td>
      </body>
    </html>
  `;
}

function duckDuckGoHtml() {
  return `
    <html>
      <body>
        <div class="result results_links">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.example.com%2Ffirst&amp;rut=abc">Fallback One</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.example.com%2Ffirst&amp;rut=abc">Fallback snippet</a>
        </div>
        <div class="result results_links">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://fallback.example.com/second">Fallback Two</a>
          </h2>
          <a class="result__snippet" href="https://fallback.example.com/second">Second fallback snippet</a>
        </div>
      </body>
    </html>
  `;
}

test("direct-web adapter fetches DuckDuckGo lite and parses bounded results", async () => {
  const http = makeMockHttp([htmlResponse(liteHtml())]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 1);
  assert.match(String(http.calls[0].url), /^https:\/\/lite\.duckduckgo\.com\/lite\/\?q=papercompany\+research/);
  assert.equal(http.calls[0].init.method, "GET");
  assert.ok(http.calls[0].init.signal, "Expected AbortSignal to enforce timeoutMs");
  assert.equal(result.engine.name, "direct-web");
  assert.equal(result.results.length, 2);
  assert.equal(http.calls[0].init.headers["User-Agent"].includes("PaperclipResearchWorkbench"), true);
  assert.equal(http.calls[0].init.headers["Accept-Language"], "en-US,en;q=0.9");
  assert.equal(http.calls[0].init.headers["X-Paperclip-Max-Response-Bytes"], "2000000");
  assert.deepEqual(
    result.results.map((entry) => entry.url),
    ["https://example.com/one", "https://docs.example.com/two?utm_source=test"],
  );
  assert.equal(result.results[0].title, "One & Two");
  assert.equal(result.results[0].snippet, "First snippet with 'entity'");
});

test("direct-web adapter falls back to DuckDuckGo html when lite has no parseable results", async () => {
  const http = makeMockHttp([
    htmlResponse("<html><body><form id='challenge-form'></form></body></html>", { status: 202 }),
    htmlResponse(duckDuckGoHtml()),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 2);
  assert.match(String(http.calls[0].url), /^https:\/\/lite\.duckduckgo\.com\/lite\//);
  assert.match(String(http.calls[1].url), /^https:\/\/duckduckgo\.com\/html\//);
  assert.deepEqual(
    result.results.map((entry) => entry.url),
    ["https://fallback.example.com/first", "https://fallback.example.com/second"],
  );
  assert.equal(result.results[0].snippet, "Fallback snippet");
});

test("direct-web adapter follows DuckDuckGo redirects before parsing fallback results", async () => {
  const http = makeMockHttp([
    htmlResponse("<html><body><form id='challenge-form'></form></body></html>", { status: 202 }),
    htmlResponse("", {
      status: 302,
      headers: {
        Location: "https://html.duckduckgo.com/html/?q=papercompany+research",
      },
    }),
    htmlResponse(duckDuckGoHtml()),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 3);
  assert.match(String(http.calls[1].url), /^https:\/\/duckduckgo\.com\/html\//);
  assert.equal(http.calls[1].init.redirect, "manual");
  assert.equal(String(http.calls[2].url), "https://html.duckduckgo.com/html/?q=papercompany+research");
  assert.deepEqual(
    result.results.map((entry) => entry.url),
    ["https://fallback.example.com/first", "https://fallback.example.com/second"],
  );
});

test("direct-web adapter refuses redirects outside DuckDuckGo", async () => {
  const http = makeMockHttp([
    htmlResponse("", {
      status: 302,
      headers: { Location: "https://example.com/unexpected" },
    }),
    htmlResponse("", {
      status: 302,
      headers: { Location: "https://example.com/unexpected" },
    }),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls.some((call) => String(call.url).includes("example.com")), false);
  assert.match(result.error, /refused unexpected redirect/);
});

test("direct-web adapter stops after the bounded DuckDuckGo redirect limit", async () => {
  const http = makeMockHttp([
    htmlResponse("", { status: 302, headers: { Location: "https://html.duckduckgo.com/html/?hop=1" } }),
    htmlResponse("", { status: 302, headers: { Location: "https://html.duckduckgo.com/html/?hop=2" } }),
    htmlResponse("", { status: 302, headers: { Location: "https://html.duckduckgo.com/html/?hop=3" } }),
    htmlResponse("", { status: 302, headers: { Location: "https://html.duckduckgo.com/html/?hop=4" } }),
    htmlResponse("<html><body>No results</body></html>"),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(http.calls.length, 5);
  assert.match(String(http.calls[4].url), /^https:\/\/duckduckgo\.com\/html\//);
  assert.match(result.error, /exceeded 3 redirects/);
});

test("direct-web adapter treats empty challenge pages as retryable failures, not zero-result success", async () => {
  const http = makeMockHttp([
    htmlResponse("<html><body><form id='challenge-form'></form></body></html>", { status: 202 }),
    htmlResponse("<html><body><p>captcha required</p></body></html>"),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterSeconds, 60);
  assert.match(result.error, /no parseable results/);
  assert.equal(http.calls.length, 2);
});

test("direct-web adapter returns retryable failure for upstream 5xx", async () => {
  const http = makeMockHttp([
    htmlResponse("Service Unavailable", {
      status: 503,
      headers: { "Retry-After": "17" },
    }),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterSeconds, 17);
  assert.match(result.error, /HTTP 503/);
  assert.equal(result.engine.name, "direct-web");
});

test("direct-web adapter returns non-retryable failure for bad request status", async () => {
  const http = makeMockHttp([htmlResponse("Bad Request", { status: 400 })]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error, /HTTP 400/);
  assert.equal(result.engine.name, "direct-web");
});

test("direct-web adapter returns retryable failure for network errors", async () => {
  const http = makeMockHttp([new Error("fetch failed")]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterSeconds, 60);
  assert.match(result.error, /fetch failed/);
  assert.equal(result.engine.name, "direct-web");
});

test("direct-web adapter prefers Exa MCP and normalizes its search results", async () => {
  const http = makeMockHttp([
    sseEventsResponse(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "exa-search-server", version: "3.2.1" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      ],
      { headers: { "Mcp-Session-Id": "exa-session-1" } },
    ),
    new Response(null, { status: 202 }),
    sseEventsResponse([
      {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: exaSearchText() }] },
      },
      { jsonrpc: "2.0", method: "notifications/resources/list_changed" },
    ]),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

  const result = await adapter.search({
    query: "2026년 소상공인 지원사업",
    maxResults: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 3);
  assert.equal(http.calls.every((call) => String(call.url) === "https://mcp.exa.ai/mcp"), true);
  assert.equal(http.calls[0].init.headers["X-Paperclip-Max-Response-Bytes"], "2000000");
  assert.equal(result.engine.provider, "exa-mcp");
  assert.equal(result.engine.upstreamVersion, "3.2.1");
  assert.deepEqual(
    result.engine.attempts.map((attempt) => ({ provider: attempt.provider, status: attempt.status })),
    [{ provider: "exa-mcp", status: "ok" }],
  );
  assert.deepEqual(
    result.results.map((entry) => ({ title: entry.title, url: entry.url, publishedAt: entry.publishedAt })),
    [
      {
        title: "2026 소상공인 지원사업 통합 공고",
        url: "https://www.bizinfo.go.kr/example/notice-1",
        publishedAt: "2025-12-30",
      },
      {
        title: "2026년도 창업지원사업 통합공고",
        url: "https://www.k-startup.go.kr/example/notice-2",
        publishedAt: null,
      },
    ],
  );
  assert.ok(result.results[0].snippet.length <= 1200, `Expected bounded snippet, got ${result.results[0].snippet.length}`);
});

test("direct-web adapter accepts a matching Exa JSON-RPC response split across SSE data lines", async () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      serverInfo: { name: "exa-search-server", version: "3.2.1" },
    },
  };
  const callResult = {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: exaSearchText() }] },
  };
  const http = makeMockHttp([
    multilineSseResponse(initialize, JSON.stringify(initialize).indexOf(',"id"') + 1, { headers: { "Mcp-Session-Id": "exa-session-multiline" } }),
    new Response(null, { status: 202 }),
    multilineSseResponse(callResult, JSON.stringify(callResult).indexOf(',"id"') + 1),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["exa-mcp"] });

  const result = await adapter.search({ query: "2026년 소상공인 지원사업", maxResults: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.engine.provider, "exa-mcp");
  assert.equal(result.results.length, 2);
});

test("direct-web adapter records an Exa failure and falls back to DuckDuckGo", async () => {
  const http = makeMockHttp([
    sseResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "service unavailable" } }, { status: 503 }),
    htmlResponse(liteHtml()),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

  const result = await adapter.search({
    query: "papercompany research",
    maxResults: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 2);
  assert.equal(String(http.calls[0].url), "https://mcp.exa.ai/mcp");
  assert.match(String(http.calls[1].url), /^https:\/\/lite\.duckduckgo\.com\/lite\//);
  assert.equal(result.engine.provider, "duckduckgo");
  assert.deepEqual(
    result.engine.attempts.map((attempt) => ({ provider: attempt.provider, status: attempt.status })),
    [
      { provider: "exa-mcp", status: "error" },
      { provider: "duckduckgo", status: "ok" },
    ],
  );
});

test("direct-web adapter classifies malformed Exa SSE as a protocol error", async () => {
  const http = makeMockHttp([
    new Response("event: message\ndata: not-json\n\n", {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Mcp-Session-Id": "exa-session-malformed",
      },
    }),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["exa-mcp"] });

  const result = await adapter.search({ query: "papercompany research", maxResults: 2 });

  assert.equal(result.ok, false);
  assert.equal(http.calls.length, 1);
  assert.equal(result.engine.attempts[0].reason, "protocol_error");
  assert.match(result.engine.attempts[0].detail, /invalid JSON/i);
});

test("direct-web adapter rejects an Exa JSON-RPC response with the wrong id", async () => {
  const http = makeMockHttp([
    sseResponse(
      {
        jsonrpc: "2.0",
        id: 99,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "exa-search-server", version: "3.2.1" },
        },
      },
      { headers: { "Mcp-Session-Id": "exa-session-wrong-id" } },
    ),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["exa-mcp"] });

  const result = await adapter.search({ query: "papercompany research", maxResults: 2 });

  assert.equal(result.ok, false);
  assert.equal(http.calls.length, 1);
  assert.equal(result.engine.attempts[0].reason, "protocol_error");
  assert.match(result.engine.attempts[0].detail, /id 1/);
});

test("direct-web adapter filters private result URLs and bounds DuckDuckGo snippets", async () => {
  const longSnippet = "public evidence ".repeat(120);
  const http = makeMockHttp([
    htmlResponse(`
      <a class="result-link" href="http://169.254.169.254/latest/meta-data">Internal metadata</a>
      <td class="result-snippet">secret</td>
      <a class="result-link" href="http://localhost./admin">Trailing-dot localhost</a>
      <td class="result-snippet">secret</td>
      <a class="result-link" href="https://source.local./admin">Trailing-dot local host</a>
      <td class="result-snippet">secret</td>
      <a class="result-link" href="https://public.example.com/notice">Public notice</a>
      <td class="result-snippet">${longSnippet}</td>
    `),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["duckduckgo"] });

  const result = await adapter.search({ query: "public notices", maxResults: 5 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.url), ["https://public.example.com/notice"]);
  assert.ok(result.results[0].snippet.length <= 1200, `Expected bounded snippet, got ${result.results[0].snippet.length}`);
});

test("direct-web adapter enforces timeout when the HTTP client ignores AbortSignal", async () => {
  const calls = [];
  const http = {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return sseResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
        { headers: { "Mcp-Session-Id": "exa-session-too-late" } },
      );
    },
  };
  const adapter = createDirectWebAdapter({ http, timeoutMs: 20, providers: ["exa-mcp"] });
  const startedAt = Date.now();

  const result = await adapter.search({ query: "papercompany research", maxResults: 2 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.engine.attempts[0].reason, "timeout");
  assert.ok(elapsedMs < 80, `Expected timeout before ignored 100ms fetch completed, took ${elapsedMs}ms`);
});

test("direct-web adapter rejects oversized provider responses before parsing", async () => {
  const http = makeMockHttp([
    sseResponse(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      {
        headers: {
          "Mcp-Session-Id": "exa-session-oversized",
          "Content-Length": "3000000",
        },
      },
    ),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000, providers: ["exa-mcp"] });

  const result = await adapter.search({ query: "papercompany research", maxResults: 2 });

  assert.equal(result.ok, false);
  assert.equal(http.calls.length, 1);
  assert.equal(result.engine.attempts[0].reason, "response_too_large");
});
