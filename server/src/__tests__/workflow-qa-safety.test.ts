import { describe, expect, it } from "vitest";
import { evaluateQaRules } from "../services/workflow/qa-rules.js";

const base = { provenanceValid: true, resultValid: true };
describe("mandatory QA document safety", () => {
  it.each([
    ["no-sensitive-data", "<p>/srv/company/private/report.json</p>"],
    ["no-sensitive-data", "/Users/operator/private/report.json"],
    ["no-sensitive-data", "<p>&#47;home/operator/private/report.json</p>"],
    ["no-sensitive-data", String.raw`<p>C:\Users\operator\report.json</p>`],
    ["no-sensitive-data", '<p>password=synthetic-placeholder</p>'],
    ["no-external-script", '<svg><script href="https://example.org/remote.js"></script></svg>'],
    ["no-external-script", '<svg><script xlink:href="https://example.org/remote.js"></script></svg>'],
    ["no-external-script", '<script type="module">import "https://example.org/remote.js";</script>'],
    ["no-external-script", '<script>import("https://example.org/remote.js")</script>'],
    ["no-external-script", '<button onclick="import(\'https://example.org/remote.js\')">Go</button>'],
    ["no-external-script", '<a href="javascript:import(\'https://example.org/remote.js\')">Go</a>'],
  ])("rejects %s without returning artifact bytes: %s", async (id, html) => {
    const result = await evaluateQaRules({ ...base, html });
    expect(result.checks.find(check => check.id === id)?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-placeholder");
  });
  it("permits inert data scripts and relative artifact navigation", async () => {
    const result = await evaluateQaRules({ ...base, html: '<script type="application/ld+json">{"name":"Report"}</script><a href="/reports/current">Read</a>' });
    expect(result.ok).toBe(true);
  });
});
