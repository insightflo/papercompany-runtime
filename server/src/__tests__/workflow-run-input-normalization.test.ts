import { describe, expect, it } from "vitest";
import { workflowRunInputErrorDetailsSchema } from "@paperclipai/shared/workflow-run-input-values";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";
import {
  normalizeWorkflowRunInputs,
  WorkflowRunInputValidationError,
} from "../services/workflow/run-input-normalization.js";
import { validateRunInputDeclarations } from "../services/workflow/run-input-derivations.js";

/**
 * [purpose] 실행 입력 정규화 순수 함수 계약: 기본값 → 파생 → 값 검증의 단일 패스와
 * 구조화 필드 오류(key/code/message)를 고정한다. 오류 문장은 표시용이며 파싱 대상이
 * 아니다(규칙 9) — 실패 식별은 항상 details.fieldErrors[].key/.code로 한다.
 */

const YT_URL = "https://youtu.be/dQw4w9WgXcQ";
const DERIVATION_MESSAGE = (key: string, source: string) =>
  `${key} could not be derived from ${source}; check the URL format`;

function detailsOf(operation: () => unknown): WorkflowRunInputValidationError["details"] {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowRunInputValidationError);
    return (error as WorkflowRunInputValidationError).details;
  }
  return expect.unreachable();
}

describe("normalizeWorkflowRunInputs", () => {
  it("derives after defaults and leaves originals unchanged", () => {
    const url = "https://youtu.be/dQw4w9WgXcQ";
    const inputs: WorkflowRunInput[] = [
      { key: "url", type: "radio", options: [{ value: url, label: "Video" }], default: url },
      { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const raw = Object.freeze({ other: "kept" });
    expect(normalizeWorkflowRunInputs(inputs, raw)).toEqual({ other: "kept", url, videoId: "dQw4w9WgXcQ" });
    expect(raw).toEqual({ other: "kept" });
  });

  it("keeps API legacy text optionality, applies webhook legacy presence only on request", () => {
    const fields = [{ key: "topic", required: true }];
    expect(normalizeWorkflowRunInputs(fields, {})).toEqual({});
    expect(() => normalizeWorkflowRunInputs(fields, {}, { legacyTextRequired: true }))
      .toThrow(WorkflowRunInputValidationError);
  });

  it("fills only missing defaults and preserves explicit false and empty array", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "enabled", type: "switch", default: true },
      { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
    ];
    expect(normalizeWorkflowRunInputs(inputs, { enabled: false, tags: [] })).toEqual({ enabled: false, tags: [] });
    expect(normalizeWorkflowRunInputs(inputs, {})).toEqual({ enabled: true, tags: ["a"] });
  });

  it("rejects null, wrong-typed, and unknown-option values without coercion", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "enabled", type: "switch" },
      { key: "pick", type: "radio", options: [{ value: "a", label: "A" }] },
      { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }] },
    ];
    const details = detailsOf(() => normalizeWorkflowRunInputs(inputs, { enabled: null, pick: "nope", tags: ["a", "a"] }));
    expect(details.fieldErrors.map((fieldError) => fieldError.code)).toEqual([
      "invalid_type",
      "invalid_option",
      "duplicate_value",
    ]);
  });

  it("reports the same typed-value failures regardless of legacy policy", () => {
    const inputs: WorkflowRunInput[] = [{ key: "enabled", type: "switch" }];
    const values = { enabled: "yes" };
    const withoutPolicy = detailsOf(() => normalizeWorkflowRunInputs(inputs, values));
    const withPolicy = detailsOf(() => normalizeWorkflowRunInputs(inputs, values, { legacyTextRequired: true }));
    expect(withPolicy).toEqual(withoutPolicy);
  });

  it("deletes an optional failed derivation and reports a required one by its key", () => {
    const optional: WorkflowRunInput[] = [
      { key: "url" },
      { key: "note", required: false, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    expect(normalizeWorkflowRunInputs(optional, { url: "https://example.com/nope" }))
      .toEqual({ url: "https://example.com/nope" });
    expect(normalizeWorkflowRunInputs(optional, {})).toEqual({});

    const required: WorkflowRunInput[] = [
      { key: "url" },
      { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const details = detailsOf(() => normalizeWorkflowRunInputs(required, {}));
    expect(details).toEqual({
      version: 1,
      code: "invalid_workflow_run_inputs",
      fieldErrors: [
        { key: "videoId", code: "derivation_failed", message: DERIVATION_MESSAGE("videoId", "url") },
      ],
    });
    // 구조화 오류 세부는 공유 스키마(versioned contract)를 통과해야 한다 — 파싱 금지 규칙의 기계 검증.
    expect(() => workflowRunInputErrorDetailsSchema.parse(details)).not.toThrow();
  });

  it("gives an explicit non-blank derived value priority over extraction", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "url" },
      { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    expect(normalizeWorkflowRunInputs(inputs, { url: YT_URL, videoId: "custom12345_" }))
      .toEqual({ url: YT_URL, videoId: "custom12345_" });
  });

  it("processes derivations once in declaration order, not topologically", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "echo", deriveFrom: { input: "videoId", extract: "youtubeVideoId" } },
      { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ];
    const details = detailsOf(() => normalizeWorkflowRunInputs(inputs, { url: "https://example.com/nope" }));
    // 선언 순서 처리: echo가 먼저 처리되어(videoId 부재) echo가 실패 키가 된다.
    // 위상정렬로 처리했다면 videoId가 실패 키가 된다.
    expect(details.fieldErrors).toEqual([
      { key: "echo", code: "derivation_failed", message: DERIVATION_MESSAGE("echo", "videoId") },
    ]);
  });

  it("keeps forward-chain output stable under re-normalization (single pass)", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "note", required: false, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
      { key: "videoId", required: false, deriveFrom: { input: "note", extract: "youtubeVideoId" } },
    ];
    const once = normalizeWorkflowRunInputs(inputs, { url: YT_URL });
    // 단일 패스: note는 url에서 파생되고, videoId는 파생된 note(11자 id)에서
    // 추출을 시도했다가 실패 → 선택 입력이므로 기존 동작대로 삭제된다.
    expect(once).toEqual({ url: YT_URL, note: "dQw4w9WgXcQ" });
    // 재정규화해도 선행 선택적 파생 결과(note)가 바뀌지 않는다.
    expect(normalizeWorkflowRunInputs(inputs, once)).toEqual(once);
  });

  it("exposes the structured class message and details shape", () => {
    const inputs: WorkflowRunInput[] = [{ key: "pick", type: "radio", options: [{ value: "a", label: "A" }] }];
    let caught: unknown;
    try {
      normalizeWorkflowRunInputs(inputs, {});
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowRunInputValidationError);
    expect((caught as WorkflowRunInputValidationError).message).toBe("Invalid workflow run input values");
    expect((caught as WorkflowRunInputValidationError).details).toEqual({
      version: 1,
      code: "invalid_workflow_run_inputs",
      fieldErrors: [{ key: "pick", code: "required", message: "'pick' 항목은 필수 입력입니다." }],
    });
  });
});

describe("validateRunInputDeclarations (domain validator)", () => {
  it.each<{ inputs: WorkflowRunInput[] }>([
    { inputs: [{ key: "section", type: "radio", options: [{ value: "a", label: "A" }], default: "invalid" }] },
    { inputs: [{ key: "same" }, { key: "same", type: "switch" }] },
  ])("rejects structurally invalid declarations at the shared safeParse gate: %j", ({ inputs }) => {
    expect(() => validateRunInputDeclarations(inputs)).toThrow(/^Invalid workflow runInputs:/);
  });

  it.each<{ name: string; inputs: WorkflowRunInput[] }>([
    { name: "self reference", inputs: [
      { key: "self", deriveFrom: { input: "self", extract: "youtubeVideoId" } },
    ] },
    { name: "cycle", inputs: [
      { key: "a", deriveFrom: { input: "b", extract: "youtubeVideoId" } },
      { key: "b", deriveFrom: { input: "a", extract: "youtubeVideoId" } },
    ] },
  ])("does not introduce a new $name restriction", ({ inputs }) => {
    expect(() => validateRunInputDeclarations(inputs)).not.toThrow();
  });
  it("rejects a deriveFrom referencing a missing source with the declaration prefix", () => {
    expect(() => validateRunInputDeclarations([
      { key: "videoId", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ])).toThrow('Invalid workflow runInputs: input "videoId" deriveFrom references unknown input "url"');
  });
});
