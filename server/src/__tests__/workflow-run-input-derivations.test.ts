import { describe, expect, it } from "vitest";
import {
  applyRunInputDerivations,
  extractYoutubeVideoId,
  validateRunInputDeclarations,
} from "../services/workflow/run-input-derivations.js";

describe("extractYoutubeVideoId", () => {
  it.each([
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?si=abc&t=1&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ?si=xyz123", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc123&t=30", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123", "dQw4w9WgXcQ"],
  ])("extracts the 11-char id from %s", (url, expected) => {
    expect(extractYoutubeVideoId(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/watch"],
    ["not a url at all"],
    [""],
    ["https://youtu.be/short"], // 5 chars — not an 11-char id
  ])("returns null for %s", (url) => {
    expect(extractYoutubeVideoId(url)).toBeNull();
  });
});

describe("validateRunInputDeclarations", () => {
  it("accepts deriveFrom referencing a declared sibling input", () => {
    expect(() => validateRunInputDeclarations([
      { key: "url", required: true },
      { key: "videoId", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ])).not.toThrow();
  });

  it("rejects deriveFrom referencing an undeclared input with the domain prefix", () => {
    expect(() => validateRunInputDeclarations([
      { key: "videoId", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ])).toThrow('Invalid workflow runInputs: input "videoId" deriveFrom references unknown input "url"');
  });

  it("accepts undefined/empty declarations", () => {
    expect(() => validateRunInputDeclarations(undefined)).not.toThrow();
    expect(() => validateRunInputDeclarations([])).not.toThrow();
  });
});

describe("applyRunInputDerivations", () => {
  const runInputs = [
    { key: "url", required: true },
    { key: "videoId", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" as const } },
  ];

  it("derives missing values from the source input", () => {
    const result = applyRunInputDerivations(runInputs, { url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(result).toEqual({
      status: "ok",
      metadata: { url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" },
    });
  });

  it("does not overwrite a user-provided value", () => {
    const result = applyRunInputDerivations(runInputs, {
      url: "https://youtu.be/dQw4w9WgXcQ",
      videoId: "custom12345_",
    });
    expect(result).toEqual({
      status: "ok",
      metadata: { url: "https://youtu.be/dQw4w9WgXcQ", videoId: "custom12345_" },
    });
  });

  it("fails with a structured error when extraction fails and the input is required", () => {
    const result = applyRunInputDerivations(runInputs, { url: "https://example.com/nope" });
    expect(result).toEqual({
      status: "error",
      message: "videoId could not be derived from url; check the URL format",
    });
  });

  it("omits optional inputs when extraction fails", () => {
    const result = applyRunInputDerivations([
      { key: "url", required: true },
      { key: "videoId", required: false, deriveFrom: { input: "url", extract: "youtubeVideoId" as const } },
    ], { url: "https://example.com/nope" });
    expect(result).toEqual({ status: "ok", metadata: { url: "https://example.com/nope" } });
  });

  it("fails when the required source input itself is missing", () => {
    const result = applyRunInputDerivations(runInputs, {});
    expect(result.status).toBe("error");
  });

  it("passes metadata through untouched when no deriveFrom is declared", () => {
    const result = applyRunInputDerivations([{ key: "url", required: true }], { url: "https://example.com" });
    expect(result).toEqual({ status: "ok", metadata: { url: "https://example.com" } });
  });
});
