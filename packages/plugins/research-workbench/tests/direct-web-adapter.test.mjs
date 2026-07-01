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
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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

test("direct-web adapter treats empty challenge pages as retryable failures, not zero-result success", async () => {
  const http = makeMockHttp([
    htmlResponse("<html><body><form id='challenge-form'></form></body></html>", { status: 202 }),
    htmlResponse("<html><body><p>captcha required</p></body></html>"),
  ]);
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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
  const adapter = createDirectWebAdapter({ http, timeoutMs: 5000 });

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
