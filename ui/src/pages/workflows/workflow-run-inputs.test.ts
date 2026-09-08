import { describe, expect, it } from "vitest";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";
import { collectWorkflowRunInputDraft, initialWorkflowRunInputDraft } from "./workflow-run-inputs.js";

function codes(result: { status: string; fieldErrors?: Array<{ key: string; code: string }> }): Array<{ key: string; code: string }> {
  return (result.fieldErrors ?? []).map(({ key, code }) => ({ key, code }));
}

describe("initialWorkflowRunInputDraft", () => {
  it("uses typed defaults, preserves false, trims text and omits optional blanks", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }], default: "manuals" },
      { key: "enabled", type: "switch" },
      { key: "url", placeholder: " https://example.com " },
      { key: "note", required: false },
      { key: "derived", required: false, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const draft = initialWorkflowRunInputDraft(inputs);
    expect(draft).toEqual({ section: "manuals", enabled: false, url: " https://example.com ", note: "" });
    expect(collectWorkflowRunInputDraft(inputs, draft)).toEqual({ status: "ready",
      metadata: { section: "manuals", enabled: false, url: "https://example.com" } });
  });

  it("keeps a prototype-named input as an own draft field", () => {
    const draft = initialWorkflowRunInputDraft([{ key: "__proto__", placeholder: "value" }]);
    expect(Object.hasOwn(draft, "__proto__")).toBe(true);
    expect(draft.__proto__).toBe("value");
  });

  it("does not fabricate a radio selection when no default is declared", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }] },
    ];
    expect(initialWorkflowRunInputDraft(inputs)).toEqual({});
  });

  it("uses a declared switch default of true and leaves a default-less checkbox absent", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "notify", type: "switch", default: true },
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }] },
    ];
    expect(initialWorkflowRunInputDraft(inputs)).toEqual({ notify: true });
  });

  it("clones checkbox default arrays so reopening starts from independent copies", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }], default: ["a"] },
    ];
    const first = initialWorkflowRunInputDraft(inputs);
    const reopened = initialWorkflowRunInputDraft(inputs);
    expect(first.tags).toEqual(["a"]);
    expect(first.tags).not.toBe(reopened.tags);
    (first.tags as string[]).push("mutated");
    expect(reopened.tags).toEqual(["a"]);
  });
});

describe("collectWorkflowRunInputDraft", () => {
  it("does not count inherited properties as required text values", () => {
    const result = collectWorkflowRunInputDraft([{ key: "constructor" }], {});
    expect(result.status).toBe("error");
    expect(codes(result)).toEqual([{ key: "constructor", code: "required" }]);
  });

  it("retains a prototype-named field in serialized metadata", () => {
    const result = collectWorkflowRunInputDraft([{ key: "__proto__" }], { ["__proto__"]: " value " });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready metadata");
    expect(JSON.stringify(result.metadata)).toBe('{"__proto__":"value"}');
  });

  it("preserves optional checkbox deselection instead of restoring its default", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
    ];
    expect(collectWorkflowRunInputDraft(inputs, { tags: [] })).toEqual({ status: "ready", metadata: { tags: [] } });
  });

  it("reports a required checkbox whose initial default is empty", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }], default: [] },
    ];
    expect(initialWorkflowRunInputDraft(inputs)).toEqual({ tags: [] });
    expect(codes(collectWorkflowRunInputDraft(inputs, initialWorkflowRunInputDraft(inputs))))
      .toEqual([{ key: "tags", code: "required" }]);
  });

  it("applies shared defaults to missing fields and drops undeclared draft keys", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "mode", type: "radio", options: [{ value: "a", label: "A" }], default: "a" },
      { key: "flag", type: "switch", default: false },
    ];
    expect(collectWorkflowRunInputDraft(inputs, { extra: "ignore" })).toEqual({
      status: "ready", metadata: { mode: "a", flag: false },
    });
  });

  it("uses shared type, membership and duplicate validation", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "mode", type: "radio", options: [{ value: "a", label: "A" }] },
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }] },
      { key: "flag", type: "switch" },
    ];
    expect(codes(collectWorkflowRunInputDraft(inputs, { mode: "unknown", tags: ["a", "a"], flag: "false" })))
      .toEqual([
        { key: "mode", code: "invalid_option" },
        { key: "tags", code: "duplicate_value" },
        { key: "flag", code: "invalid_type" },
      ]);
  });

  it("trims only text and preserves exact non-trimmed option strings", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "url", placeholder: "" },
      { key: "mode", type: "radio", options: [{ value: " manual ", label: "공백 옵션" }] },
      { key: "tags", type: "checkbox", options: [{ value: " manual tag ", label: "공백 태그" }] },
    ];
    const draft = { url: "  https://example.com  ", mode: " manual ", tags: [" manual tag "] };
    expect(collectWorkflowRunInputDraft(inputs, draft)).toEqual({
      status: "ready",
      metadata: { url: "https://example.com", mode: " manual ", tags: [" manual tag "] },
    });
  });

  it("reports a required error for missing required text", () => {
    const inputs: WorkflowRunInput[] = [{ key: "url" }];
    const result = collectWorkflowRunInputDraft(inputs, { url: "   " });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(codes(result)).toEqual([{ key: "url", code: "required" }]);
  });

  it("reports a required error for an explicitly emptied checkbox but passes a false switch", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }], required: true, default: ["a"] },
      { key: "flag", type: "switch", required: true },
    ];
    const result = collectWorkflowRunInputDraft(inputs, { tags: [], flag: false });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(codes(result)).toEqual([{ key: "tags", code: "required" }]);
    const passing = collectWorkflowRunInputDraft(inputs, { tags: ["a"], flag: false });
    expect(passing).toEqual({ status: "ready", metadata: { tags: ["a"], flag: false } });
  });

  it("preserves an empty array once the user selects and deselects checkbox items", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }] },
    ];
    const selected = collectWorkflowRunInputDraft(inputs, { tags: ["a"] });
    expect(selected).toEqual({ status: "ready", metadata: { tags: ["a"] } });
    const deselected = collectWorkflowRunInputDraft(inputs, { tags: [] });
    expect(deselected.status).toBe("error");
    if (deselected.status !== "error") return;
    expect(codes(deselected)).toEqual([{ key: "tags", code: "required" }]);
  });

  it("keeps an optional radio without default absent from the draft and metadata", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "mode", type: "radio", options: [{ value: "fast", label: "빠름" }], required: false },
    ];
    const draft = initialWorkflowRunInputDraft(inputs);
    expect(draft).toEqual({});
    expect(collectWorkflowRunInputDraft(inputs, draft)).toEqual({ status: "ready", metadata: {} });
  });

  it("never adds derived fields to the draft or submission metadata", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "url", required: true },
      { key: "videoId", required: true, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const draft = initialWorkflowRunInputDraft(inputs);
    expect(draft).toEqual({ url: "" });
    expect("videoId" in draft).toBe(false);
    const result = collectWorkflowRunInputDraft(inputs, { url: "https://youtu.be/abc", videoId: "accidental" });
    expect(result).toEqual({ status: "ready", metadata: { url: "https://youtu.be/abc" } });
  });

  it("keeps a user-changed radio selection over the declared default", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "section", type: "radio", options: [
        { value: "manuals", label: "매뉴얼" },
        { value: "albums", label: "앨범" },
      ], default: "manuals" },
    ];
    expect(collectWorkflowRunInputDraft(inputs, { section: "albums" })).toEqual({
      status: "ready",
      metadata: { section: "albums" },
    });
  });
});
