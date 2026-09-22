import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { inspectHtmlDocument } from "../services/judgment/html-preflight-executor.js";

describe("html-preflight document inspection", () => {
  it("returns conservative ok output and DOM size stats for a normal document", () => {
    const source = "<!doctype html><html><head><title>ok</title></head><body><main><p>Hello structural preflight</p></main></body></html>";
    const document = new JSDOM(source).window.document;

    const result = inspectHtmlDocument(document, source.length);

    expect(result).toEqual({
      ok: true,
      findings: [],
      stats: { docChars: source.length, textChars: 24, nodeCount: expect.any(Number) },
    });
    expect(result.stats.nodeCount).toBeGreaterThan(5);
  });

  it("marks whitespace-only documents as near-empty", () => {
    const document = new JSDOM("   \n\t  ").window.document;

    const result = inspectHtmlDocument(document, 7);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(["near_empty_text_content: visibleTextChars=0 (<20)"]);
    expect(result.stats).toEqual({ docChars: 7, textChars: 0, nodeCount: expect.any(Number) });
  });

  it("marks a parsed document without body as grossly structurally broken", () => {
    const document = new JSDOM("<html></html>").window.document;
    document.documentElement.removeChild(document.body);

    const result = inspectHtmlDocument(document, 13);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      "missing_body",
      "near_empty_text_content: visibleTextChars=0 (<20)",
    ]);
    expect(result.stats).toEqual({ docChars: 13, textChars: 0, nodeCount: expect.any(Number) });
  });
});
