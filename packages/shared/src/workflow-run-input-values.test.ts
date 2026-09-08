import { expect, it, describe } from "vitest";
import type { WorkflowRunInput } from "./validators/workflow-run-inputs.js";
import {
  applyWorkflowRunInputDefaults,
  validateWorkflowRunInputValues,
  workflowRunInputErrorDetailsSchema,
} from "./workflow-run-input-values.js";

const fields: WorkflowRunInput[] = [
  { key: "enabled", type: "switch", default: true },
  {
    key: "sections",
    type: "checkbox",
    required: false,
    options: [{ value: "manuals", label: "매뉴얼" }],
    default: ["manuals"],
  },
];

describe("applyWorkflowRunInputDefaults", () => {
  it("preserves explicit responses and unrelated metadata", () => {
    const raw = Object.freeze({ enabled: false, sections: Object.freeze([]), trace: 7 });
    const next = applyWorkflowRunInputDefaults(fields, raw);
    expect(next).toEqual({ enabled: false, sections: [], trace: 7 });
    expect(next).not.toBe(raw);
    expect(validateWorkflowRunInputValues(fields, next)).toEqual([]);
  });

  it("does not treat null as missing", () => {
    const next = applyWorkflowRunInputDefaults(fields, { enabled: null });
    expect(next.enabled).toBeNull();
    expect(validateWorkflowRunInputValues(fields, next)).toContainEqual(
      expect.objectContaining({ key: "enabled", code: "invalid_type" }),
    );
  });

  it("applies defaults only for missing or undefined declared new-control keys", () => {
    expect(applyWorkflowRunInputDefaults(fields, {})).toEqual({ enabled: true, sections: ["manuals"] });
    expect(applyWorkflowRunInputDefaults(fields, { enabled: undefined, sections: undefined })).toEqual({
      enabled: true,
      sections: ["manuals"],
    });
    expect(applyWorkflowRunInputDefaults(fields, { enabled: false, sections: [] })).toEqual({
      enabled: false,
      sections: [],
    });
  });

  it("skips text inputs and copies array defaults without mutating the declaration", () => {
    const declarations: WorkflowRunInput[] = [
      { key: "url", type: "text" },
      { key: "sections", type: "checkbox", options: [{ value: "a", label: "A" }], default: ["a"] },
    ];
    const frozenDefault = declarations[1].default;
    if (frozenDefault) Object.freeze(frozenDefault);
    const next = applyWorkflowRunInputDefaults(declarations, {});
    expect(next).toEqual({ sections: ["a"] });
    expect(next.sections).toEqual(["a"]);
    expect(next.sections).not.toBe(frozenDefault);
  });

  it("treats allowed keys such as __proto__ as ordinary declared keys", () => {
    const next = applyWorkflowRunInputDefaults(
      [{ key: "__proto__", type: "switch", default: true }],
      {} as Record<string, unknown>,
    );
    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(next.__proto__).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(applyWorkflowRunInputDefaults([{ key: "toString", type: "switch", default: true }], {})).toEqual({
      toString: true,
    });
  });

  it("returns a plain copy when inputs or metadata are absent", () => {
    expect(applyWorkflowRunInputDefaults(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(applyWorkflowRunInputDefaults(fields, undefined)).toEqual({ enabled: true, sections: ["manuals"] });
  });
});

describe("validateWorkflowRunInputValues", () => {
  it("requires missing declared controls and accepts explicit false", () => {
    const inputs: WorkflowRunInput[] = [{ key: "enabled", type: "switch", required: true }];
    expect(validateWorkflowRunInputValues(inputs, {})).toEqual([
      expect.objectContaining({ key: "enabled", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { enabled: false })).toEqual([]);
    expect(validateWorkflowRunInputValues(inputs, { enabled: "false" })).toEqual([
      expect.objectContaining({ key: "enabled", code: "invalid_type" }),
    ]);
    // required 플래그는 기존 derive/webhook 시맨틱과 동일하게 생략 시 필수(required !== false)다.
    expect(validateWorkflowRunInputValues([{ key: "enabled", type: "switch" }], {})).toEqual([
      expect.objectContaining({ key: "enabled", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues([{ key: "enabled", type: "switch", required: false }], {})).toEqual([]);
  });

  it("validates radio membership and required selection", () => {
    const inputs: WorkflowRunInput[] = [
      {
        key: "section",
        type: "radio",
        required: true,
        options: [{ value: "manuals", label: "매뉴얼" }, { value: "concepts", label: "개념" }],
        default: "manuals",
      },
    ];
    expect(validateWorkflowRunInputValues(inputs, { section: "concepts" })).toEqual([]);
    expect(validateWorkflowRunInputValues(inputs, { section: "unknown" })).toEqual([
      expect.objectContaining({ key: "section", code: "invalid_option" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { section: 3 })).toEqual([
      expect.objectContaining({ key: "section", code: "invalid_type" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, {})).toEqual([
      expect.objectContaining({ key: "section", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues([{ ...inputs[0], required: false }], {})).toEqual([]);
  });

  it("validates checkbox items, duplicates, and required length", () => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
    const inputs: WorkflowRunInput[] = [{ key: "pick", type: "checkbox", required: true, options }];
    expect(validateWorkflowRunInputValues(inputs, { pick: ["b"] })).toEqual([]);
    expect(validateWorkflowRunInputValues(inputs, { pick: [] })).toEqual([
      expect.objectContaining({ key: "pick", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues([{ ...inputs[0], required: false }], { pick: [] })).toEqual([]);
    expect(validateWorkflowRunInputValues(inputs, { pick: ["a", "a"] })).toEqual([
      expect.objectContaining({ key: "pick", code: "duplicate_value" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { pick: ["nope"] })).toEqual([
      expect.objectContaining({ key: "pick", code: "invalid_option" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { pick: "a" })).toEqual([
      expect.objectContaining({ key: "pick", code: "invalid_type" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { pick: ["a", 3] })).toEqual([
      expect.objectContaining({ key: "pick", code: "invalid_type" }),
    ]);
  });

  it.each([{}, { pick: undefined }])("keeps missing optional controls absent and rejects required checkbox: %j", (raw) => {
    const optional: WorkflowRunInput[] = [
      { key: "pick", type: "checkbox", required: false, options: [{ value: "a", label: "A" }] },
      { key: "radio", type: "radio", required: false, options: [{ value: "a", label: "A" }] },
      { key: "enabled", type: "switch", required: false },
    ];
    const next = applyWorkflowRunInputDefaults(optional, raw);
    expect(next).toEqual(raw);
    expect(Object.keys(next)).toEqual(Object.keys(raw));
    expect(validateWorkflowRunInputValues(optional, next)).toEqual([]);
    expect(validateWorkflowRunInputValues([{ ...optional[0], required: true }], next)).toEqual([
      expect.objectContaining({ key: "pick", code: "required" }),
    ]);
  });

  it("applies a required checkbox empty default but still rejects it as unanswered", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "pick", type: "checkbox", required: true, options: [{ value: "a", label: "A" }], default: [] },
    ];
    const next = applyWorkflowRunInputDefaults(inputs, {});
    expect(next).toEqual({ pick: [] });
    expect(validateWorkflowRunInputValues(inputs, next)).toEqual([
      expect.objectContaining({ key: "pick", code: "required" }),
    ]);
  });

  it("ignores text inputs unless the legacy presence flag is set", () => {
    const inputs: WorkflowRunInput[] = [{ key: "url", type: "text", required: true }];
    expect(validateWorkflowRunInputValues(inputs, {})).toEqual([]);
    const legacy = { legacyTextRequired: true } as const;
    expect(validateWorkflowRunInputValues(inputs, {}, legacy)).toEqual([
      expect.objectContaining({ key: "url", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { url: "   " }, legacy)).toEqual([
      expect.objectContaining({ key: "url", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { url: null }, legacy)).toEqual([
      expect.objectContaining({ key: "url", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { url: " https://x " }, legacy)).toEqual([]);
    expect(validateWorkflowRunInputValues(inputs, { url: 7 }, legacy)).toEqual([]);
    // required 플래그 생략 시에도 레거시 웹훅과 동일하게 필수로 본다(required !== false).
    expect(validateWorkflowRunInputValues([{ key: "url", type: "text" }], {}, legacy)).toEqual([
      expect.objectContaining({ key: "url", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues([{ key: "url", type: "text", required: false }], {}, legacy)).toEqual([]);
  });

  it("uses hasOwn presence so inherited keys stay ordinary declared keys", () => {
    const inputs: WorkflowRunInput[] = [{ key: "toString", type: "switch", required: true }];
    expect(validateWorkflowRunInputValues(inputs, {})).toEqual([
      expect.objectContaining({ key: "toString", code: "required" }),
    ]);
    expect(validateWorkflowRunInputValues(inputs, { toString: false })).toEqual([]);
    const protoInputs: WorkflowRunInput[] = [{ key: "__proto__", type: "switch", required: true }];
    const ownProto: Record<string, unknown> = {};
    Object.defineProperty(ownProto, "__proto__", { enumerable: true, value: null });
    expect(validateWorkflowRunInputValues(protoInputs, ownProto)).toEqual([
      expect.objectContaining({ key: "__proto__", code: "invalid_type" }),
    ]);
  });

  it("reports no errors for undeclared metadata", () => {
    expect(validateWorkflowRunInputValues([], { any: "thing" })).toEqual([]);
    expect(validateWorkflowRunInputValues(undefined, { any: "thing" })).toEqual([]);
  });

  it("round-trips error details through the schema and rejects malformed details", () => {
    const errors = validateWorkflowRunInputValues(
      [{ key: "enabled", type: "switch", required: true }],
      { enabled: "nope" },
    );
    const details = { version: 1, code: "invalid_workflow_run_inputs", fieldErrors: errors };
    expect(workflowRunInputErrorDetailsSchema.parse(details)).toEqual(details);
    expect(workflowRunInputErrorDetailsSchema.safeParse(details)).toEqual({ success: true, data: details });
    const unversioned = { code: "invalid_workflow_run_inputs", fieldErrors: errors };
    expect(workflowRunInputErrorDetailsSchema.safeParse(unversioned).success).toBe(false);
    expect(workflowRunInputErrorDetailsSchema.safeParse({ ...details, version: 2 }).success).toBe(false);
    expect(workflowRunInputErrorDetailsSchema.safeParse({ ...details, code: "other" }).success).toBe(false);
    expect(
      workflowRunInputErrorDetailsSchema.safeParse({ ...details, fieldErrors: [{ key: "k", code: "nope", message: "m" }] })
        .success,
    ).toBe(false);
    expect(
      workflowRunInputErrorDetailsSchema.safeParse({ ...details, fieldErrors: [{ key: "k", code: "required" }] })
        .success,
    ).toBe(false);
  });

  it("builds fixed display messages from declared labels or keys", () => {
    const inputs: WorkflowRunInput[] = [
      { key: "enabled", label: "사용 여부", type: "switch", required: true },
      { key: "pick", type: "checkbox", required: true, options: [{ value: "a", label: "A" }] },
    ];
    const errors = validateWorkflowRunInputValues(inputs, { pick: ["a", "a"] });
    expect(errors).toHaveLength(2);
    expect(errors[0].key).toBe("enabled");
    expect(errors[0].code).toBe("required");
    expect(errors[0].message).toBe(validateWorkflowRunInputValues(inputs, {})[0].message);
    expect(errors[1].key).toBe("pick");
    expect(errors[1].code).toBe("duplicate_value");
    expect(errors[1].message).toBe(
      validateWorkflowRunInputValues(inputs, { enabled: false, pick: ["b", "b"] })[0].message,
    );
  });
});
