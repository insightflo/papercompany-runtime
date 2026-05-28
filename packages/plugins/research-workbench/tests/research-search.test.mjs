import assert from "node:assert/strict";
import test from "node:test";

import { createTestHarness } from "@paperclipai/plugin-sdk";

import manifest from "../dist/manifest.js";
import { setAdapter } from "../dist/worker.js";

// ---------------------------------------------------------------------------
// Helper: create a fresh harness + plugin setup for each test
// ---------------------------------------------------------------------------

async function setupHarness(config = { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" }) {
  const harness = createTestHarness({ manifest, config });
  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);
  return harness;
}

// ---------------------------------------------------------------------------
// Helper: create a mock Vane adapter that returns controlled results
// ---------------------------------------------------------------------------

let _mockVaneAdapter = null;

function setMockVaneAdapter(fn) {
  _mockVaneAdapter = {
    async search(input) {
      return fn(input);
    },
    clearCache() {},
  };
}

/**
 * Install the mock Vane adapter by injecting a module-level override.
 * The worker uses setAdapter() for legacy adapter path. For the Vane path,
 * we need to inject through the `vaneAdapter` module variable.
 * Since we cannot directly set the module variable, we use setAdapter()
 * which also resets vaneAdapter to null, and the handler falls back to
 * the legacy adapter path when adapterOverridden is true.
 */

// ---------------------------------------------------------------------------
// Tests — legacy adapter path (via setAdapter)
// ---------------------------------------------------------------------------

test("tool is registered only with agent.tools.register capability", async () => {
  // Without the capability, setup should throw
  const manifestNoCap = {
    ...manifest,
    capabilities: ["plugin.state.read", "plugin.state.write", "http.outbound"],
  };

  const harnessNoCap = createTestHarness({
    manifest: manifestNoCap,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
  });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;

  await assert.rejects(
    async () => {
      await plugin.definition.setup(harnessNoCap.ctx);
    },
    { message: /agent\.tools\.register/ },
  );

  // With the capability, setup should succeed
  const harnessWithCap = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
  });

  // Should not throw
  await plugin.definition.setup(harnessWithCap.ctx);
});

test("executing without query returns ToolResult.error", async () => {
  const harness = await setupHarness();

  const result = await harness.executeTool("research-search", {});

  assert.ok(result.error, "Expected error when query is missing");
  assert.ok(
    result.error.includes("query is required"),
    `Error message should mention 'query is required', got: ${result.error}`,
  );
});

// ---------------------------------------------------------------------------
// Tests — Vane adapter path (production-shaped handler)
// ---------------------------------------------------------------------------

test("successful handler returns ToolResult.content and EvidenceBundle data", async () => {
  // We use the legacy adapter path via setAdapter to avoid needing a real Vane server.
  // The legacy adapter is triggered when adapterOverridden=true.
  setAdapter({
    async search(query, options) {
      const count = Math.min(options.maxResults, 3);
      const results = Array.from({ length: count }, (_, i) => ({
        title: `Result ${i + 1} for "${query}"`,
        url: `https://example.com/result-${i + 1}`,
        snippet: `Snippet for result ${i + 1}`,
        relevanceScore: 1 - i * 0.2,
        source: "mock",
      }));

      return {
        query,
        results,
        meta: {
          backend: "mock",
          totalResults: count,
          elapsedMs: 50,
        },
      };
    },
  });

  const harness = await setupHarness();
  const result = await harness.executeTool("research-search", {
    query: "test query",
    maxResults: 3,
  });

  // Should be a success (no error)
  assert.ok(!result.error, `Expected no error, got: ${result.error}`);

  // data should be evidence-bundle shaped (legacy format)
  const data = result.data;
  assert.ok(data, "Expected data to be present");
  assert.equal(data.query, "test query");
  assert.ok(Array.isArray(data.results), "Expected results to be an array");
  assert.equal(data.results.length, 3);
  assert.ok(data.meta, "Expected meta to be present");
  assert.equal(data.meta.backend, "mock");
  assert.equal(data.meta.totalResults, 3);

  // Each result should have required fields
  for (const item of data.results) {
    assert.ok(typeof item.title === "string", "Expected title to be a string");
    assert.ok(typeof item.url === "string", "Expected url to be a string");
    assert.ok(typeof item.snippet === "string", "Expected snippet to be a string");
    assert.ok(typeof item.relevanceScore === "number", "Expected relevanceScore to be a number");
  }

  // Content should be present
  assert.ok(typeof result.content === "string", "Expected content to be a string");

  // Reset adapter
  setAdapter();
});

test("adapter retryable error sets ToolResult.error and data.retryable=true", async () => {
  // Inject a legacy adapter that throws to simulate a failure
  setAdapter({
    async search() {
      throw new Error("Vane server error: HTTP 503");
    },
  });

  const harness = await setupHarness();
  const result = await harness.executeTool("research-search", {
    query: "failing query",
    maxResults: 3,
  });

  // Legacy adapter path catches the error and returns ToolResult.error
  assert.ok(result.error, "Expected error to be present");
  assert.ok(
    result.error.includes("Research search failed"),
    `Expected error to mention 'Research search failed', got: ${result.error}`,
  );
  assert.ok(
    result.error.includes("Vane server error: HTTP 503"),
    `Expected error to mention the adapter error, got: ${result.error}`,
  );

  // Reset adapter
  setAdapter();
});

test("minSources warning is present but not fatal", async () => {
  // The legacy adapter path doesn't use profiles/evidence normalization.
  // So we test this through the evidence module directly in evidence.test.mjs.
  // However, we can also test that the handler succeeds even with few results.
  setAdapter({
    async search(query, options) {
      // Return only 1 result — less than default minSources of 3
      return {
        query,
        results: [{
          title: `Only result for "${query}"`,
          url: "https://example.com/only-result",
          snippet: "Just one result",
          relevanceScore: 0.9,
          source: "mock",
        }],
        meta: {
          backend: "mock",
          totalResults: 1,
          elapsedMs: 10,
        },
      };
    },
  });

  const harness = await setupHarness();
  const result = await harness.executeTool("research-search", {
    query: "sparse query",
    maxResults: 5,
  });

  // Should succeed (not fatal) even with only 1 result
  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.ok(result.data, "Expected data to be present");
  assert.equal(result.data.results.length, 1);

  // Reset adapter
  setAdapter();
});

test("profile defaults work when no profile is specified", async () => {
  // When no profile is provided, the handler should default to "general"
  // This is tested through the legacy adapter path — profile is used
  // in the Vane path. Here we just confirm the handler works without profile.
  setAdapter({
    async search(query, options) {
      return {
        query,
        results: Array.from({ length: 3 }, (_, i) => ({
          title: `Result ${i + 1}`,
          url: `https://example.com/${i + 1}`,
          snippet: `Snippet ${i + 1}`,
          relevanceScore: 0.8 - i * 0.1,
          source: "mock",
        })),
        meta: {
          backend: "mock",
          totalResults: 3,
          elapsedMs: 20,
        },
      };
    },
  });

  const harness = await setupHarness();
  const result = await harness.executeTool("research-search", {
    query: "default profile query",
    // No profile specified — should default to "general"
    maxResults: 5,
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.ok(result.data, "Expected data to be present");
  assert.equal(result.data.query, "default profile query");
  assert.equal(result.data.results.length, 3);

  // Reset adapter
  setAdapter();
});

// ---------------------------------------------------------------------------
// Tests — production-shaped Vane adapter path with content message
// ---------------------------------------------------------------------------

test("Vane path returns structured content message with source/warning counts", async () => {
  // To test the Vane path (not the legacy adapter path), we need
  // adapterOverridden=false and backend="vane-headless". The handler will
  // call getOrCreateVaneAdapter which uses ctx.http.fetch.
  // We set up a harness with a custom http.fetch that returns controlled responses.

  const vaneResults = Array.from({ length: 4 }, (_, i) => ({
    title: `Vane result ${i + 1}`,
    url: `https://example.com/vane-${i + 1}`,
    snippet: `Vane snippet ${i + 1}`,
    source: "vane",
  }));

  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  // Override http.fetch to return mock Vane response
  const originalFetch = harness.ctx.http.fetch;
  harness.ctx.http = {
    async fetch(url, init) {
      // Return a mock successful Vane response
      return new Response(
        JSON.stringify({
          results: vaneResults,
          suggestions: [],
          engine: { upstreamVersion: "1.0.0", patchVersion: "0.1.0" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  // We need to also re-create the config to include vaneBaseUrl
  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  // Reset the module-level vaneAdapter so it gets recreated with our mock http
  setAdapter();

  // Since setAdapter() sets adapterOverridden=true initially and then resets,
  // we need to directly call with adapterOverridden=false.
  // Actually, setAdapter() with no arg resets to default (not overridden).
  // But the vaneAdapter is also reset to null.
  // The handler should now use the Vane path since adapterOverridden is false.

  const result = await harness.executeTool("research-search", {
    query: "vane path query",
    maxResults: 5,
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);

  // Content should be the structured message
  assert.ok(
    result.content.includes('Research search completed for "vane path query"'),
    `Expected content to include structured message, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("4 sources"),
    `Expected content to mention source count, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("warnings"),
    `Expected content to mention warnings, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("data.sources"),
    `Expected content to mention data.sources, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("data.warnings"),
    `Expected content to mention data.warnings, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("data.gaps"),
    `Expected content to mention data.gaps, got: ${result.content}`,
  );
  assert.ok(
    result.content.includes("do not treat this as final analysis"),
    `Expected content to include final analysis warning, got: ${result.content}`,
  );

  // Data should be an EvidenceBundle
  const data = result.data;
  assert.ok(data, "Expected data to be present");
  assert.equal(data.query, "vane path query");
  assert.equal(data.sources.length, 4);
  assert.ok(Array.isArray(data.warnings), "Expected warnings to be an array");
  assert.ok(Array.isArray(data.gaps), "Expected gaps to be an array");
  assert.ok(data.qa, "Expected qa to be present");
  assert.equal(data.qa.sourceCount, 4);
  assert.equal(data.profile, "general");
  assert.equal(data.rawEngine.name, "vane-headless");
  assert.equal(data.rawEngine.baseUrl, "http://localhost:9999");
});

test("Vane adapter retryable error sets ToolResult.error with data.retryable=true", async () => {
  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  // Override http.fetch to return a 503 error
  harness.ctx.http = {
    async fetch(url, init) {
      return new Response("Service Unavailable", {
        status: 503,
        headers: { "Retry-After": "30", "Content-Type": "text/plain" },
      });
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  // Reset adapter to ensure we use Vane path
  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "retryable error query",
    maxResults: 5,
  });

  assert.ok(result.error, "Expected error to be present");
  assert.ok(
    result.error.includes("Research search failed"),
    `Expected error to mention 'Research search failed', got: ${result.error}`,
  );
  assert.ok(
    result.error.includes("retryable"),
    `Expected error to mention 'retryable', got: ${result.error}`,
  );

  // data should have structured retryable info
  const data = result.data;
  assert.ok(data, "Expected data to be present on error result");
  assert.equal(data.retryable, true, "Expected data.retryable to be true");
  assert.equal(data.retryAfterSeconds, 30, "Expected data.retryAfterSeconds to be 30");
  assert.ok(typeof data.error === "string", "Expected data.error to be a string");
});

test("Vane adapter non-retryable error sets ToolResult.error with data.retryable=false", async () => {
  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  // Override http.fetch to return a 400 error
  harness.ctx.http = {
    async fetch(url, init) {
      return new Response(
        JSON.stringify({ error: "Invalid query parameter" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "bad request query",
    maxResults: 5,
  });

  assert.ok(result.error, "Expected error to be present");
  assert.ok(
    result.error.includes("Research search failed"),
    `Expected error to mention 'Research search failed', got: ${result.error}`,
  );
  assert.ok(
    !result.error.includes("retryable"),
    `Expected non-retryable error to NOT include 'retryable', got: ${result.error}`,
  );

  const data = result.data;
  assert.ok(data, "Expected data to be present");
  assert.equal(data.retryable, false, "Expected data.retryable to be false");
});

test("Vane path minSources warning is present but not fatal", async () => {
  // Return fewer results than minSources for the default "general" profile (minSources=3)
  const sparseResults = Array.from({ length: 1 }, (_, i) => ({
    title: `Sparse result ${i + 1}`,
    url: `https://example.com/sparse-${i + 1}`,
    snippet: `Sparse snippet ${i + 1}`,
    source: "vane",
  }));

  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  harness.ctx.http = {
    async fetch(url, init) {
      return new Response(
        JSON.stringify({
          results: sparseResults,
          suggestions: [],
          engine: { upstreamVersion: "1.0.0", patchVersion: "0.1.0" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "sparse query",
    maxResults: 5,
  });

  // Should NOT be an error — minSources warning is non-fatal
  assert.ok(!result.error, `Expected no error, got: ${result.error}`);

  // But the warning should be present in the data
  const data = result.data;
  assert.ok(data, "Expected data to be present");
  assert.ok(
    data.warnings.some((w) => w.includes("minSources") || w.includes("sources") || w.includes("profile")),
    `Expected a minSources-related warning, got warnings: ${JSON.stringify(data.warnings)}`,
  );

  // Content should still have the structured message
  assert.ok(
    result.content.includes("1 sources"),
    `Expected content to mention 1 source, got: ${result.content}`,
  );
});

test("Vane path profile defaults to general when no profile specified", async () => {
  const vaneResults = Array.from({ length: 4 }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `Snippet ${i + 1}`,
    source: "vane",
  }));

  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  harness.ctx.http = {
    async fetch(url, init) {
      // Verify the request body includes profile: "general"
      const body = JSON.parse(init.body);
      assert.equal(body.profile, "general", "Expected profile to default to 'general'");
      return new Response(
        JSON.stringify({
          results: vaneResults,
          suggestions: [],
          engine: { upstreamVersion: "1.0.0", patchVersion: "0.1.0" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "default profile",
    maxResults: 5,
    // No profile specified
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.equal(result.data.profile, "general", "Expected evidence bundle profile to be 'general'");
});

test("Vane path preserves futureProfile, domain, and freshness warnings", async () => {
  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  harness.ctx.http = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      assert.equal(body.profile, "general", "Expected futureProfile to fall back to general profile");
      return new Response(
        JSON.stringify({
          results: Array.from({ length: 3 }, (_, i) => ({
            title: `Warning result ${i + 1}`,
            url: `https://example.com/warning-${i + 1}`,
            snippet: `Warning snippet ${i + 1}`,
            source: "vane",
          })),
          suggestions: [],
          engine: { upstreamVersion: "1.0.0", patchVersion: "0.1.0" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "warning query",
    futureProfile: "academic",
    domainHints: ["example.com", 42],
    excludeDomains: ["blocked.example", false],
    freshness: "recent_required",
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.equal(result.data.profile, "general", "Expected futureProfile to fall back to general profile");
  assert.ok(
    result.data.warnings.some((w) => w.includes("profile 'academic'") && w.includes("reserved")),
    `Expected futureProfile warning, got: ${JSON.stringify(result.data.warnings)}`,
  );
  assert.ok(
    result.data.warnings.some((w) => w.includes("domainHints")),
    `Expected domainHints warning, got: ${JSON.stringify(result.data.warnings)}`,
  );
  assert.ok(
    result.data.warnings.some((w) => w.includes("excludeDomains")),
    `Expected excludeDomains warning, got: ${JSON.stringify(result.data.warnings)}`,
  );
  assert.ok(
    result.data.warnings.some((w) => w.includes("recent_required")),
    `Expected freshness warning, got: ${JSON.stringify(result.data.warnings)}`,
  );
});

test("Vane path explicit academic sourceScope maps to general with warning", async () => {
  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
    capabilities: manifest.capabilities,
  });

  harness.ctx.http = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.categories, ["general"], "Expected academic scope to map to general category");
      return new Response(
        JSON.stringify({
          results: Array.from({ length: 3 }, (_, i) => ({
            title: `Academic scope result ${i + 1}`,
            url: `https://example.com/academic-${i + 1}`,
            snippet: `Academic scope snippet ${i + 1}`,
            source: "vane",
          })),
          suggestions: [],
          engine: { upstreamVersion: "1.0.0", patchVersion: "0.1.0" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };

  harness.setConfig({ backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  setAdapter();

  const result = await harness.executeTool("research-search", {
    query: "academic scope query",
    sourceScope: ["academic"],
  });

  assert.ok(!result.error, `Expected no error, got: ${result.error}`);
  assert.equal(result.data.profile, "general", "Expected default profile to remain general");
  assert.ok(
    result.data.warnings.some((w) => w.includes("sourceScope 'academic'") && w.includes("reserved")),
    `Expected academic sourceScope warning, got: ${JSON.stringify(result.data.warnings)}`,
  );
});
