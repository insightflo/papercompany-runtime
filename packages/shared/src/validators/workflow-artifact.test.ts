import { describe, expect, it } from "vitest";
import { manualQaResultSchema, toolArtifactReceiptSchema, toolArtifactContractSchema } from "./workflow-artifact.js";
import { fixtureHash, legacyQaResult, legacyReceipt } from "./__tests__/fixtures/artifact-legacy.js";

describe("generic artifact boundaries", () => {
  it("accepts declared generic step schemas and publication roles", () => {
    expect(toolArtifactContractSchema.safeParse({ schemaVersion: "example.result.v2", role: "publication", inputStepId: "write" }).success).toBe(true);
  });
  it("reads generic v1 receipts and hash-bound v2 receipts", () => {
    const generic = { ...legacyReceipt, relativePath: "result.json", resultSchema: "example.result.v2" };
    expect(toolArtifactReceiptSchema.safeParse(generic).success).toBe(true);
    expect(toolArtifactReceiptSchema.safeParse({ ...generic, schemaVersion: "workflow.tool-artifact.v2", contractHash: fixtureHash, qaConfigHash: fixtureHash }).success).toBe(true);
    expect(toolArtifactReceiptSchema.safeParse({ ...generic, schemaVersion: "workflow.tool-artifact.v2" }).success).toBe(false);
    for (const relativePath of ["../result.json", "a/b.json", "a\\\\b.json", ".", "..", "/result.json"]) {
      expect(toolArtifactReceiptSchema.safeParse({ ...generic, relativePath }).success).toBe(false);
    }
  });
});

describe("legacy artifact characterization", () => {
  it("preserves the content producer result and receipt", () => {
    expect(manualQaResultSchema.parse(legacyQaResult)).toEqual(legacyQaResult);
    expect(toolArtifactReceiptSchema.parse(legacyReceipt)).toEqual(legacyReceipt);
  });
  it("requires HTML digest and ancillary binding together", () => {
    const { contentSha256, ...base } = legacyQaResult;
    const html = { ...base, mode: "html", htmlPath: "/fixture/index.html", htmlSha256: contentSha256, ancillaryManifest: [] };
    expect(manualQaResultSchema.safeParse(html).success).toBe(true);
    expect(toolArtifactReceiptSchema.safeParse({ ...legacyReceipt, input: { ...legacyReceipt.input, mode: "html" } }).success).toBe(false);
    expect(toolArtifactReceiptSchema.safeParse({ ...legacyReceipt, input: { ...legacyReceipt.input, mode: "html",
      htmlManifest: { path: "/fixture/index.html", sha256: fixtureHash, byteSize: 1 }, ancillaryManifest: [] } }).success).toBe(true);
  });
});
