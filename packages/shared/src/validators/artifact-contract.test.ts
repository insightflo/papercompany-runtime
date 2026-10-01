import { describe, expect, it } from "vitest";
import { artifactContractSchema, selectArtifactValues } from "./artifact-contract.js";
import { qaConfigSchema, resolveEffectiveQaConfig, canonicalQaJson } from "./qa-config.js";
import { workflowQaResultSchema, adaptQaResult } from "./workflow-artifact.js";
import { fixtureHash, legacyQaResult } from "./__tests__/fixtures/artifact-legacy.js";
import { workflowStepDefinitionSchema } from "./workflow.js";

const contract = { role: "qa", resultFileName: "result.json", resultSchemaVersion: "example.qa.v1",
  resultAdapter: "legacy-qa", inputParams: { content: "source", out: "destination" },
  deploymentFiles: ["scripts/check.mjs"], inputEnvelopeVersion: "example.input.v1",
  assetDiscovery: ["/blocks/*/image/asset"], defaultRules: { rules: {} } };
describe("artifact contract", () => {
  it("validates declarations without a domain name", () => {
    expect(artifactContractSchema.parse(contract)).toEqual(contract);
    for (const patch of [{ surprise: true }, { resultFileName: "../x" }, { deploymentFiles: ["/absolute"] },
      { deploymentFiles: ["scripts/../x"] }, { inputParams: { content: "--source" } }, { assetDiscovery: ["$.blocks"] }]) {
      expect(artifactContractSchema.safeParse({ ...contract, ...patch }).success).toBe(false);
    }
  });
  it("selects own JSON pointer values, expands arrays, skips absent values", () => {
    expect(selectArtifactValues({ blocks: [{ image: { asset: "one.png" } }, {}, { image: { asset: "two.png" } }] },
      ["/blocks/*/image/asset", "/missing"])).toEqual(["one.png", "two.png"]);
    expect(selectArtifactValues({ "a/b": { "~c": 1 } }, ["/a~1b/~0c", "/toString"])).toEqual([1]);
  });
  it("normalizes declared legacy structure only after schema equality", () => {
    const declared = artifactContractSchema.parse(contract);
    const result = adaptQaResult({ ...legacyQaResult, schemaVersion: contract.resultSchemaVersion }, declared);
    expect(result.inputDigest).toEqual({ sha256: fixtureHash, mode: "content" });
    expect(() => adaptQaResult(legacyQaResult, declared)).toThrow();
    expect(workflowQaResultSchema.parse({ schemaVersion: "workflow.qa-result.v1", ok: true,
      checks: [{ id: "check", ok: true }], inputDigest: { sha256: fixtureHash } }).ok).toBe(true);
  });
});
describe("QA config", () => {
  it("validates qaConfig at the workflow definition boundary", () => {
    expect(workflowStepDefinitionSchema.parse({ id: "check", type: "tool", qaConfig: { rules: {} } }).qaConfig).toEqual({ rules: {} });
    expect(workflowStepDefinitionSchema.safeParse({ id: "check", qaConfig: { rules: { provenance: { enabled: false } } } }).success).toBe(false);
  });
  it("rejects unknown rules, unknown params and disabled mandatory checks", () => {
    for (const rules of [{ arbitrary: {} }, { provenance: { enabled: false } }, { "https-links": { params: { allowHttp: true } } },
      { "min-source-links": { params: { min: -1 } } }, { "tag-count": { params: { min: 3, max: 1 } } }]) {
      expect(qaConfigSchema.safeParse({ rules }).success).toBe(false);
    }
  });
  it("merges mandatory, preset and step configuration without mutating inputs", () => {
    const preset = { rules: { "min-source-links": { params: { min: 2 } } } };
    const config = resolveEffectiveQaConfig(preset, { rules: { "min-source-links": { enabled: false } } });
    expect(config.rules.provenance).toEqual({ enabled: true });
    expect(config.rules["min-source-links"]).toEqual({ enabled: false, params: { min: 2 } });
    expect(preset.rules["min-source-links"]).toEqual({ params: { min: 2 } });
    expect(canonicalQaJson({ z: 1, a: { c: 2, b: 1 } })).toBe(canonicalQaJson({ a: { b: 1, c: 2 }, z: 1 }));
  });
});
