import { describe, expect, it } from "vitest";
import { collectWorkflowRunInputs } from "./workflow-run-inputs.js";

describe("collectWorkflowRunInputs", () => {
  it("collects values for declared inputs and passes them through as metadata", () => {
    const result = collectWorkflowRunInputs(
      [{ key: "url", label: "YouTube URL", required: true, placeholder: "https://..." }],
      () => "https://example.com/watch?v=abc",
    );
    expect(result).toEqual({ status: "ready", metadata: { url: "https://example.com/watch?v=abc" }, derivedNote: null });
  });

  it("treats required as true by default and aborts on empty required input", () => {
    const result = collectWorkflowRunInputs([{ key: "url" }], () => "   ");
    expect(result).toEqual({ status: "missing_required", key: "url", label: "url" });
  });

  it("allows empty optional inputs and omits them from metadata", () => {
    const result = collectWorkflowRunInputs(
      [
        { key: "url", required: true },
        { key: "note", required: false },
      ],
      (message) => (message === "url" ? "https://example.com" : ""),
    );
    expect(result).toEqual({ status: "ready", metadata: { url: "https://example.com" }, derivedNote: null });
  });

  it("returns cancelled when the prompt is dismissed", () => {
    const result = collectWorkflowRunInputs([{ key: "url" }], () => null);
    expect(result).toEqual({ status: "cancelled" });
  });

  it("uses the declared label for the prompt message and missing-required report", () => {
    const prompts: string[] = [];
    collectWorkflowRunInputs(
      [{ key: "url", label: "유튜브 URL", required: false }],
      (message) => {
        prompts.push(message);
        return "x";
      },
    );
    expect(prompts).toEqual(["유튜브 URL"]);
    const missing = collectWorkflowRunInputs(
      [{ key: "url", label: "유튜브 URL" }],
      () => "",
    );
    expect(missing).toEqual({ status: "missing_required", key: "url", label: "유튜브 URL" });
  });

  it("collects multiple inputs in declaration order", () => {
    const answers: Record<string, string> = { url: "https://example.com", lang: "ko" };
    const result = collectWorkflowRunInputs(
      [{ key: "url" }, { key: "lang" }],
      (message) => answers[message] ?? "",
    );
    expect(result).toEqual({ status: "ready", metadata: { url: "https://example.com", lang: "ko" }, derivedNote: null });
  });

  it("skips prompting for derived inputs and reports a derivation note", () => {
    const prompts: string[] = [];
    const result = collectWorkflowRunInputs(
      [
        { key: "url", label: "유튜브 URL", required: true },
        { key: "videoId", label: "영상 ID", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
      ],
      (message) => {
        prompts.push(message);
        return "https://youtu.be/dQw4w9WgXcQ";
      },
    );
    expect(prompts).toEqual(["유튜브 URL"]);
    expect(result).toEqual({
      status: "ready",
      metadata: { url: "https://youtu.be/dQw4w9WgXcQ" },
      derivedNote: "영상 ID 값은 자동으로 추출됩니다",
    });
  });

  it("omits the derivation note when no derived inputs are declared", () => {
    const result = collectWorkflowRunInputs(
      [{ key: "url", required: true }],
      () => "https://example.com",
    );
    expect(result).toEqual({
      status: "ready",
      metadata: { url: "https://example.com" },
      derivedNote: null,
    });
  });
});
