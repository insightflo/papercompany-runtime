import { describe, expect, it } from "vitest";
import { formatTestResult, parseTestInput } from "./toolTestModel";

describe("parseTestInput", () => {
  it("parses a valid JSON object", () => {
    const result = parseTestInput('{"limit":2}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ limit: 2 });
  });

  it("blocks invalid JSON with a clear error", () => {
    const result = parseTestInput("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("rejects a JSON array as not an object", () => {
    const result = parseTestInput("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("object");
  });

  it("rejects a JSON primitive as not an object", () => {
    const result = parseTestInput('"hello"');
    expect(result.ok).toBe(false);
  });

  it("accepts an empty object", () => {
    const result = parseTestInput("{}");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });
});

describe("formatTestResult", () => {
  it("pretty-prints a JSON value", () => {
    expect(formatTestResult({ a: 1 })).toBe("{\n  \"a\": 1\n}");
  });

  it("returns an empty string for undefined", () => {
    expect(formatTestResult(undefined)).toBe("");
  });

  it("never throws on non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatTestResult(circular)).not.toThrow();
  });
});
