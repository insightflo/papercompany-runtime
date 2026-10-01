import { describe, expect, it } from "vitest";
import { evaluateQaRules, hashArtifactContract, hashQaConfig } from "../services/workflow/qa-rules.js";
import { resolveEffectiveQaConfig } from "@paperclipai/shared";

const base = { provenanceValid: true, resultValid: true, json: { title: "A report", source: "https://example.com/article" } };
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
  it("hashes validated configs canonically and detects policy changes", () => {
    expect(hashQaConfig({ rules: {} })).toBe(hashQaConfig(resolveEffectiveQaConfig()));
    expect(hashQaConfig({ rules: { "tag-count": { params: { min: 1 } } } })).not.toBe(hashQaConfig({ rules: {} }));
    const contract = { role: "qa" as const, resultFileName: "result.json", resultSchemaVersion: "workflow.qa-result.v1",
      resultAdapter: "generic" as const, inputParams: {}, deploymentFiles: ["check.mjs"], inputEnvelopeVersion: "input.v1" };
    expect(hashArtifactContract(contract)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashArtifactContract({ ...contract, resultFileName: "other.json" })).not.toBe(hashArtifactContract(contract));
  });
});
