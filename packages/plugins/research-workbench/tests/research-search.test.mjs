import assert from "node:assert/strict";
import test from "node:test";

import { createTestHarness } from "@paperclipai/plugin-sdk";

import manifest from "../dist/manifest.js";
import { setAdapter } from "../dist/worker.js";

// ---------------------------------------------------------------------------
// Helper: mock adapter returning fake evidence
// ---------------------------------------------------------------------------

function createMockAdapter() {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Tests
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

  // Import worker plugin definition dynamically
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
  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
  });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  const result = await harness.executeTool("research-search", {});

  assert.ok(result.error, "Expected error when query is missing");
  assert.ok(
    result.error.includes("query is required"),
    `Error message should mention 'query is required', got: ${result.error}`,
  );
});

test("executing with mock adapter returns EvidenceBundle-shaped data", async () => {
  // Inject the mock adapter before importing plugin
  setAdapter(createMockAdapter());

  const harness = createTestHarness({
    manifest,
    config: { backend: "vane-headless", vaneBaseUrl: "http://localhost:9999" },
  });

  const pluginModule = await import("../dist/worker.js");
  const plugin = pluginModule.default;
  await plugin.definition.setup(harness.ctx);

  const result = await harness.executeTool("research-search", {
    query: "test query",
    maxResults: 3,
  });

  // Should be a success (no error)
  assert.ok(!result.error, `Expected no error, got: ${result.error}`);

  // data should be EvidenceBundle-shaped
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

  // Reset adapter
  setAdapter();
});
