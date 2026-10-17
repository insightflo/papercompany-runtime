import { describe, expect, it } from "vitest";
import { evaluateQaRules, hashArtifactContract, hashQaConfig } from "../services/workflow/qa-rules.js";
import { resolveEffectiveQaConfig } from "@paperclipai/shared";

const base = { provenanceValid: true, resultValid: true, json: { title: "A report", source: "https://example.com/article" } };
describe("https-links loopback exemption (local-install evidence)", () => {
  it.each([
    "http://127.0.0.1:7077/mcp",
    "http://localhost:3000/docs",
    "http://[::1]:8080/health",
    "http://sub.localhost:5173/",
  ])("allows plain-http loopback link %s in code blocks and strings", async (link) => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json, code: `curl ${link}`, plain: link } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
  it.each([
    "http://example.com/insecure",
    "http://127.0.0.2/not-the-loopback-host",
    "http://0.0.0.0:8080/",
  ])("still rejects plain-http link %s", async (link) => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json, link } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
  it.each([
    "http://user:pass@127.0.0.1:7077/mcp",
    "http://user@localhost:3000/docs",
    "http://:pass@[::1]:8080/health",
  ])("rejects plain-http loopback link %s carrying credentials (exemption is bare loopback addresses only)", async (link) => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json, link } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
  it("still allows loopback URLs whose @ appears only in the path (no userinfo)", async () => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json, link: "http://127.0.0.1:8080/@loop" } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(true);
  });
  it("keeps https links and relative/fragment links passing unchanged", async () => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json, https: "https://example.com/a", rel: "assets/x.png", frag: "#top" } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
  it("does not count loopback http links as https source links", async () => {
    const config = resolveEffectiveQaConfig({ rules: { "min-source-links": { params: { min: 1 } } } });
    const result = await evaluateQaRules({ ...base, config, json: { title: "Local proof", verify: "curl http://127.0.0.1:7077/mcp" } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(true);
    expect(result.checks.find(c => c.id === "min-source-links")?.ok).toBe(false);
  });
  it("accepts a kenfold-style local-install report whose code block cites http://127.0.0.1:7077/mcp", async () => {
    const result = await evaluateQaRules({ ...base, json: {
      title: "kenfold service report",
      install: "kenfold serve --port 7077",
      verify: "curl -X POST http://127.0.0.1:7077/mcp",
      evidence: "MCP endpoint responded over loopback http",
    } });
    expect(result.checks.find(c => c.id === "https-links")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("generic runtime QA rules", () => {
  it("always runs the six mandatory rules without requiring a plugin result", async () => {
    const result = await evaluateQaRules(base);
    expect(result.ok).toBe(true);
    expect(result.checks.map(c => c.id)).toEqual(["provenance", "result-format", "no-sensitive-data", "no-external-script", "no-external-iframe", "https-links"]);
    expect((await evaluateQaRules({ ...base, provenanceValid: false })).ok).toBe(false);
    expect((await evaluateQaRules({ ...base, resultValid: false })).ok).toBe(false);
  });
  it.each([
    ["no-external-script", '<script src="https://example.com/code.js"></script>'],
    ["no-external-script", '<SCRIPT SRC=//example.com/code.js></SCRIPT>'],
    ["no-external-iframe", '<iframe src="https://example.com"></iframe>'],
    ["https-links", '<a href="h&#116;tp://example.com">source</a>'],
    ["https-links", '<a href="javascript:alert(1)">source</a>'],
    ["no-sensitive-data", '{"api_key":"synthetic-placeholder-not-a-real-key"}'],
  ])("rejects %s without echoing sensitive document text", async (id, html) => {
    const result = await evaluateQaRules({ ...base, html });
    expect(result.checks.find(c => c.id === id)?.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-placeholder");
  });
  it("also inspects HTML nested in JSON, but ignores local fragment links", async () => {
    expect((await evaluateQaRules({ ...base, json: { nested: ['<script src="evil.js"></script>'] } })).ok).toBe(false);
    expect((await evaluateQaRules({ ...base, html: '<a href="#section">jump</a><img src="assets/image.png">' })).ok).toBe(true);
  });
  it("uses preset rules with step overrides and returns each runtime failure", async () => {
    const config = resolveEffectiveQaConfig({ rules: { "min-source-links": { params: { min: 2 } },
      "tag-count": { params: { min: 2 } }, "required-fields": { params: { pointers: ["/title", "/summary"] } } } },
      { rules: { "min-source-links": { params: { min: 1 } } } });
    const result = await evaluateQaRules({ ...base, config, json: { ...base.json, tags: ["one"] } });
    expect(result.checks.find(c => c.id === "min-source-links")?.ok).toBe(true);
    expect(result.checks.filter(c => !c.ok).map(c => c.id)).toEqual(["tag-count", "required-fields"]);
  });
  it("requires verified asset manifest matches and literal template-remnant patterns", async () => {
    const config = resolveEffectiveQaConfig({ rules: {
      "uploaded-asset-required": {}, "asset-existence": { params: { pointers: ["/images/*"] } },
      "no-template-remnants": { params: { patterns: ["REPLACE.[ME]"] } },
    } });
    const json = { images: ["one.png"], title: "REPLACE.[ME]" };
    const result = await evaluateQaRules({ ...base, config, json, assetManifest: [{ fileName: "other.png", sha256: "a".repeat(64), byteSize: 1 }] });
    expect(result.checks.filter(c => !c.ok).map(c => c.id).sort()).toEqual(["asset-existence", "no-template-remnants"]);
    expect((await evaluateQaRules({ ...base, config, json: { images: ["one.png"] },
      assetManifest: [{ fileName: "one.png", sha256: "a".repeat(64), byteSize: 1 }] })).ok).toBe(true);
  });
  it("fails closed for missing rule params, without fetching", async () => {
    for (const rules of [{ "required-fields": {} }, { "min-source-links": {} }]) {
      expect((await evaluateQaRules({ ...base, config: { rules } })).ok).toBe(false);
    }
  });
  it("propagates qa_document_limit as its own infra failure instead of failing content checks", async () => {
    // Depth > 100 hits inspectQaDocument's structural limit; the failure is an
    // inspection/infra limit, not a content-rule verdict (no rework loop derivation).
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 150; i += 1) deep = { child: deep };
    await expect(evaluateQaRules({ ...base, json: deep })).rejects.toThrow("qa_document_limit");
  });
  it("reports the violating links in the https-links check detail (credentials stripped)", async () => {
    const result = await evaluateQaRules({ ...base, json: { ...base.json,
      bad: "http://example.com/insecure",
      credentialed: "https://user:secret@evil.example/x" } });
    const check = result.checks.find(c => c.id === "https-links")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("http://example.com/insecure");
    // Userinfo is stripped from the echoed link — the detail must never echo credentials.
    expect(String(check.detail)).toContain("https://evil.example/x");
    expect(JSON.stringify(result)).not.toContain("secret");
    // A passing document keeps the check detail-free (contract unchanged on success).
    const passing = await evaluateQaRules(base);
    expect(passing.checks.find(c => c.id === "https-links")?.detail).toBeUndefined();
  });
  it("hashes validated configs canonically and detects policy changes", () => {
    expect(hashQaConfig({ rules: {} })).toBe(hashQaConfig(resolveEffectiveQaConfig()));
    expect(hashQaConfig({ rules: { "tag-count": { params: { min: 1 } } } })).not.toBe(hashQaConfig({ rules: {} }));
    const contract = { role: "qa" as const, resultFileName: "result.json", resultSchemaVersion: "workflow.qa-result.v1",
      resultAdapter: "generic" as const, inputParams: {}, deploymentFiles: ["check.mjs"], inputEnvelopeVersion: "input.v1" };
    expect(hashArtifactContract(contract)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashArtifactContract({ ...contract, resultFileName: "other.json" })).not.toBe(hashArtifactContract(contract));
  });
});
