import { describe, expect, it } from "vitest";
import { createWorkflowDefinitionSchema, updateWorkflowDefinitionSchema } from "./workflow.js";
import { workflowRunInputSchema, workflowRunInputsSchema } from "./workflow-run-inputs.js";

const section = {
  key: "section",
  type: "radio",
  required: true,
  options: [
    { value: "manuals", label: "매뉴얼" },
    { value: "concepts", label: "개념 설명" },
  ],
  default: "manuals",
};

describe("workflowRunInputSchema declarations", () => {
  it("accepts radio through create and patch", () => {
    expect(
      createWorkflowDefinitionSchema.parse({ name: "Onboarding", runInputs: [section] }).runInputs,
    ).toEqual([section]);
    expect(updateWorkflowDefinitionSchema.parse({ runInputs: [section] }).runInputs).toEqual([section]);
  });

  it("accepts omitted runInputs (missing)", () => {
    expect(createWorkflowDefinitionSchema.parse({ name: "Onboarding" }).runInputs).toBeUndefined();
    expect(createWorkflowDefinitionSchema.parse({ name: "Onboarding", runInputs: [] }).runInputs).toEqual([]);
  });

  it("accepts legacy text declarations with and without an explicit type", () => {
    const parsed = createWorkflowDefinitionSchema.parse({
      name: "YouTube report",
      runInputs: [
        { key: "url", label: "YouTube URL", required: true, placeholder: "https://…" },
        { key: "videoId", type: "text", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
      ],
    });
    expect(parsed.runInputs).toHaveLength(2);
  });

  it("accepts a switch declared with an explicit false default", () => {
    expect(workflowRunInputSchema.parse({ key: "enabled", type: "switch", default: false })).toEqual({
      key: "enabled",
      type: "switch",
      default: false,
    });
  });

  it("accepts checkbox defaults including the empty array", () => {
    const declaration = {
      key: "sections",
      type: "checkbox",
      options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념" }],
      default: [],
    };
    expect(workflowRunInputSchema.parse(declaration)).toEqual(declaration);
    expect(
      workflowRunInputSchema.parse({ ...declaration, default: ["manuals", "concepts"] }).default,
    ).toEqual(["manuals", "concepts"]);
  });

  it.each([
    { ...section, default: false },
    { ...section, default: "unknown" },
    { ...section, options: [{ value: "", label: "Empty" }] },
    { ...section, options: [{ value: "x", label: "A" }, { value: "x", label: "B" }] },
    { ...section, deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    { key: "enabled", type: "switch", default: "false" },
    { key: "enabled", type: "switch", options: [] },
    { key: "text", default: "not-supported" },
  ])("rejects incompatible declaration %#", (value) => {
    expect(workflowRunInputSchema.safeParse(value).success).toBe(false);
  });

  it("rejects duplicate checkbox default entries and unknown default members", () => {
    const options = [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념" }];
    expect(
      workflowRunInputSchema.safeParse({ key: "s", type: "checkbox", options, default: ["manuals", "manuals"] })
        .success,
    ).toBe(false);
    expect(
      workflowRunInputSchema.safeParse({ key: "s", type: "checkbox", options, default: ["nope"] }).success,
    ).toBe(false);
  });

  it("rejects duplicate declaration keys", () => {
    const result = workflowRunInputsSchema.safeParse([
      { key: "url", type: "text" },
      { key: "url", type: "switch" },
    ]);
    expect(result.success).toBe(false);
    expect(updateWorkflowDefinitionSchema.safeParse({ runInputs: [{ key: "a" }, { key: "a" }] }).success).toBe(
      false,
    );
  });

  it("rejects a sixth run input", () => {
    const inputs = Array.from({ length: 6 }, (_, index) => ({ key: `input_${index}` }));
    expect(workflowRunInputsSchema.safeParse(inputs).success).toBe(false);
    expect(workflowRunInputsSchema.safeParse(inputs.slice(0, 5)).success).toBe(true);
    expect(updateWorkflowDefinitionSchema.safeParse({ runInputs: inputs }).success).toBe(false);
  });

  it("rejects invalid extractors and unknown properties", () => {
    expect(
      workflowRunInputSchema.safeParse({
        key: "videoId",
        deriveFrom: { input: "url", extract: "vimeoId" },
      }).success,
    ).toBe(false);
    expect(workflowRunInputSchema.safeParse({ key: "url", extra: 1 }).success).toBe(false);
    expect(
      createWorkflowDefinitionSchema.safeParse({ name: "X", runInputs: [{ key: "url", extra: 1 }] }).success,
    ).toBe(false);
  });

  it("preserves the existing declaration key regex", () => {
    expect(workflowRunInputSchema.safeParse({ key: "bad-key", type: "switch" }).success).toBe(false);
    expect(workflowRunInputSchema.safeParse({ key: "".padEnd(41, "a"), type: "switch" }).success).toBe(false);
  });
});
