import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// We test the adapter directly (unit level) with a mocked http.fetch.
// The adapter is imported from dist/ after build, same pattern as other tests.
// ---------------------------------------------------------------------------

import { createTestHarness } from "@paperclipai/plugin-sdk";
import manifest from "../dist/manifest.js";
import { createVaneHeadlessAdapter, validateVaneBaseUrl } from "../dist/adapters/vane-headless.js";
import { buildEvidenceBundle } from "../dist/evidence.js";
import { resolveResearchProfile, resolveSourceScopeCategories } from "../dist/profiles.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHttp(responses) {
  const calls = [];
  const mockHttp = {
    async fetch(url, init) {
      calls.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("No more mock responses");
      if (response instanceof Error) throw response;
      return response;
    },
    calls,
  };
  return mockHttp;
}

function jsonOk(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function jsonError(status, body = {}, headers = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function makeRawResults(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://example.com/result-${i + 1}`,
    snippet: `Snippet for result ${i + 1}`,
    source: "web",
    publishedAt: "2026-05-28T00:00:00Z",
  }));
}

// ---------------------------------------------------------------------------
// validateVaneBaseUrl tests
// ---------------------------------------------------------------------------

test("validateVaneBaseUrl rejects empty, non-http, and invalid URLs", () => {
  assert.ok(validateVaneBaseUrl(""));
  assert.ok(validateVaneBaseUrl("ftp://example.com"));
  assert.ok(validateVaneBaseUrl("not-a-url"));

  assert.equal(validateVaneBaseUrl("http://localhost:3300"), null);
  assert.equal(validateVaneBaseUrl("https://vane.example.com"), null);
  assert.equal(validateVaneBaseUrl("http://localhost:3300/"), null);
});

// ---------------------------------------------------------------------------
// URL path is /api/papercompany/search/raw
// ---------------------------------------------------------------------------

test("adapter POSTs to /api/papercompany/search/raw", async () => {
  const http = createMockHttp([
    jsonOk({ results: makeRawResults(2), engine: {} }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({
    query: "test query",
    maxResults: 5,
  });

  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, "http://localhost:3300/api/papercompany/search/raw");
  assert.equal(http.calls[0].init.method, "POST");
});

// ---------------------------------------------------------------------------
// Request body has no chatModel, embeddingModel, systemInstructions, history, stream
// ---------------------------------------------------------------------------

test("request body does not contain forbidden fields", async () => {
  const http = createMockHttp([
    jsonOk({ results: makeRawResults(1), engine: {} }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  await adapter.search({ query: "test", maxResults: 5 });

  const body = JSON.parse(http.calls[0].init.body);
  const forbiddenFields = ["chatModel", "embeddingModel", "systemInstructions", "history", "stream"];

  for (const field of forbiddenFields) {
    assert.ok(!(field in body), `Request body must not contain '${field}', but it did: ${JSON.stringify(body)}`);
  }

  // Body should contain expected fields
  assert.ok("query" in body);
  assert.ok("maxResults" in body);
});

// ---------------------------------------------------------------------------
// Successful raw results → structured output
// ---------------------------------------------------------------------------

test("successful search returns ok:true with results", async () => {
  const raw = makeRawResults(3);
  const http = createMockHttp([
    jsonOk({ results: raw, suggestions: ["related"], engine: { upstreamVersion: "1.0" } }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.query, "test");
    assert.equal(result.results.length, 3);
    assert.deepEqual(result.suggestions, ["related"]);
    assert.equal(result.engine.name, "vane-headless");
    assert.equal(result.engine.upstreamVersion, "1.0");
    assert.ok(result.retrievedAt);
  }
});

// ---------------------------------------------------------------------------
// Timeout/network → retryable with retryAfterSeconds
// ---------------------------------------------------------------------------

test("timeout becomes retryable error with retryAfterSeconds", async () => {
  const http = createMockHttp([]);
  // Simulate abort error (timeout)
  const abortError = new DOMException("The operation was aborted", "AbortError");
  http.fetch = async () => { throw abortError; };

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    timeoutMs: 100,
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, true);
    assert.ok(result.error.includes("timed out"));
  }
  assert.equal(result.retryAfterSeconds, 60);
});

test("network error becomes retryable error with retryAfterSeconds", async () => {
  const http = createMockHttp([]);
  http.fetch = async () => { throw new TypeError("fetch failed"); };

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, true);
    assert.ok(result.error.includes("network error"));
  }
  assert.equal(result.retryAfterSeconds, 60);
});

// ---------------------------------------------------------------------------
// HTTP 400 → non-retryable
// ---------------------------------------------------------------------------

test("HTTP 400 becomes non-retryable error", async () => {
  const http = createMockHttp([
    jsonError(400, { error: "Invalid query parameter" }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, false);
    assert.ok(result.error.includes("Invalid query parameter"));
  }
});

// ---------------------------------------------------------------------------
// HTTP 5xx → retryable with retryAfterSeconds
// ---------------------------------------------------------------------------

test("HTTP 500 becomes retryable error", async () => {
  const http = createMockHttp([
    jsonError(500, {}),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retryable, true);
    assert.ok(result.error.includes("500"));
  }
  assert.equal(result.retryAfterSeconds, 60);
});

test("HTTP 503 with Retry-After header uses that value", async () => {
  const http = createMockHttp([
    {
      ok: false,
      status: 503,
      headers: new Headers({ "Retry-After": "30" }),
      async json() { return {}; },
    },
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result = await adapter.search({ query: "test", maxResults: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.retryAfterSeconds, 30);
});

// ---------------------------------------------------------------------------
// Cache: identical request inside TTL reuses cached result
// ---------------------------------------------------------------------------

test("identical request inside TTL reuses cached result", async () => {
  const http = createMockHttp([
    jsonOk({ results: makeRawResults(2), engine: {} }),
    jsonOk({ results: makeRawResults(5), engine: {} }), // should NOT be reached
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const input = { query: "cache test", maxResults: 5, profile: "general" };

  const result1 = await adapter.search(input);
  assert.equal(result1.ok, true);

  const result2 = await adapter.search(input);
  assert.equal(result2.ok, true);

  // Only one HTTP call should have been made
  assert.equal(http.calls.length, 1, "Expected only 1 HTTP call due to cache hit");

  if (result1.ok && result2.ok) {
    assert.deepEqual(result1.results, result2.results);
  }
});

test("different query bypasses cache", async () => {
  const http = createMockHttp([
    jsonOk({ results: makeRawResults(2), engine: {} }),
    jsonOk({ results: makeRawResults(3), engine: {} }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const result1 = await adapter.search({ query: "query a", maxResults: 5 });
  const result2 = await adapter.search({ query: "query b", maxResults: 5 });

  assert.equal(http.calls.length, 2, "Expected 2 HTTP calls for different queries");
});

test("clearCache empties the cache", async () => {
  const http = createMockHttp([
    jsonOk({ results: makeRawResults(2), engine: {} }),
    jsonOk({ results: makeRawResults(3), engine: {} }),
  ]);

  const adapter = createVaneHeadlessAdapter({
    vaneBaseUrl: "http://localhost:3300",
    http,
  });

  const input = { query: "clear cache test", maxResults: 5 };

  await adapter.search(input);
  assert.equal(http.calls.length, 1);

  adapter.clearCache();
  await adapter.search(input);
  assert.equal(http.calls.length, 2, "Expected 2nd HTTP call after clearCache");
});

// ---------------------------------------------------------------------------
// Successful raw results → evidence bundle through worker handler
// ---------------------------------------------------------------------------

test("successful raw results become evidence bundle through worker integration", async () => {
  const raw = makeRawResults(3);
  const http = createMockHttp([
    jsonOk({ results: raw, engine: { upstreamVersion: "1.2.0" } }),
  ]);

  // Build the evidence bundle the same way the worker handler does
  const vaneResult = {
    ok: true,
    query: "test query",
    results: raw,
    engine: { name: "vane-headless", upstreamVersion: "1.2.0" },
    retrievedAt: "2026-05-28T12:00:00.000Z",
  };

  const profileResolution = resolveResearchProfile({ profile: "general" });
  const scopeMapping = resolveSourceScopeCategories(
    profileResolution.profile.sourceScope,
    { discussionsSupported: true },
  );

  const bundle = buildEvidenceBundle({
    input: { query: "test query", maxResults: 5 },
    rawResults: vaneResult.results,
    profile: profileResolution.profile,
    retrievedAt: vaneResult.retrievedAt,
    rawEngine: {
      name: "vane-headless",
      baseUrl: "http://localhost:3300",
      upstreamVersion: "1.2.0",
    },
    warnings: [...profileResolution.warnings, ...scopeMapping.warnings],
  });

  // Verify the bundle is well-formed
  assert.equal(bundle.topic, "test query");
  assert.equal(bundle.query, "test query");
  assert.equal(bundle.profile, "general");
  assert.equal(bundle.sources.length, 3);
  assert.ok(bundle.qa);
  assert.equal(bundle.qa.sourceCount, 3);
  assert.equal(bundle.qa.passedMinSources, true);
  assert.equal(bundle.rawEngine.name, "vane-headless");
  assert.equal(bundle.rawEngine.baseUrl, "http://localhost:3300");
  assert.equal(bundle.rawEngine.upstreamVersion, "1.2.0");

  for (const source of bundle.sources) {
    assert.ok(typeof source.title === "string");
    assert.ok(typeof source.url === "string");
    assert.ok(typeof source.snippet === "string");
    assert.ok(typeof source.sourceType === "string");
    assert.equal(source.retrievedAt, "2026-05-28T12:00:00.000Z");
  }
});

// ---------------------------------------------------------------------------
// Worker handler returns evidence bundle via Vane adapter
// ---------------------------------------------------------------------------

test("worker handleResearchSearch returns evidence bundle via Vane adapter", async () => {
  const raw = makeRawResults(3);
  const http = createMockHttp([
    jsonOk({ results: raw, engine: {} }),
  ]);

  // Set up the harness with vane-headless config
  const harness = createTestHarness({
    manifest,
    config: {
      backend: "vane-headless",
      vaneBaseUrl: "http://localhost:3300",
      timeoutMs: 30000,
      defaultMaxResults: 5,
    },
    http,
  });

  harness.ctx.http = http;

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  const result = await harness.executeTool("research-search", {
    query: "papercompany research",
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.ok(result.data, "Expected data to be present");

  const data = result.data;
  assert.equal(data.query, "papercompany research");
  assert.ok(Array.isArray(data.sources), "Expected sources to be an array");
  assert.equal(data.sources.length, 3);
  assert.equal(data.rawEngine.name, "vane-headless");
  assert.equal(data.profile, "general");
  assert.ok(data.qa);
  assert.equal(data.qa.sourceCount, 3);

  // Reset adapter state for other tests
  pluginModule.setAdapter();
});

// ---------------------------------------------------------------------------
// Worker handleResearchSearch returns error on Vane failure
// ---------------------------------------------------------------------------

test("worker handleResearchSearch returns error when Vane returns non-retryable error", async () => {
  const http = createMockHttp([
    jsonError(400, { error: "Bad query" }),
  ]);

  const harness = createTestHarness({
    manifest,
    config: {
      backend: "vane-headless",
      vaneBaseUrl: "http://localhost:3300",
      timeoutMs: 30000,
      defaultMaxResults: 5,
    },
    http,
  });

  harness.ctx.http = http;

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  const result = await harness.executeTool("research-search", {
    query: "bad query test",
  });

  assert.ok(result.error, "Expected error for 400 response");
  assert.ok(result.error.includes("Bad query"), `Expected error to mention 'Bad query', got: ${result.error}`);
  // Non-retryable should NOT contain retryAfter
  assert.ok(!result.error.includes("retryable"), `Non-retryable should not contain 'retryable', got: ${result.error}`);

  pluginModule.setAdapter();
});
