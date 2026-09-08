import { z } from "zod";

/**
 * [purpose] 워크플로 실행 입력(runInputs) 선언 계약. 실행 팝업의 선택형 컨트롤
 * (radio/checkbox/switch)과 기존 text·파생(deriveFrom) 입력을 하나의 유니온으로 정의한다.
 * [care] 규칙 8 — 이 선언은 정의 시점 계약이다. 선언 JSON을 화면·서버가 동일하게
 * 검증하며, 임의 정규식/코드는 저장하지 않는다. deriveFrom.extract 는 고정 추출기
 * 레지스트리만 허용하고, 소스 키 존재 검증은 저장 시점 서버 도메인 검증이 담당한다.
 */

export const workflowRunInputDeriveFromSchema = z.object({
  input: z.string().min(1),
  extract: z.enum(["youtubeVideoId"]),
}).strict();

const keySchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/);

const workflowRunInputOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string(),
}).strict();

const textBranchSchema = z.object({
  key: keySchema,
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  type: z.literal("text").optional(),
  // [목적] 실행 입력의 서버 파생 선언. extract는 고정 명명 추출기 레지스트리만 허용한다 —
  // 정의에 임의 정규식을 저장하지 않는다(ReDoS·실행권위 방어). deriveFrom은 text에만 허용.
  deriveFrom: workflowRunInputDeriveFromSchema.optional(),
  options: z.never().optional(),
  // 이번 작업에서 text에는 새 default 기능을 추가하지 않는다(설계 §3 호환성 경계).
  default: z.never().optional(),
}).strict();

const radioBranchSchema = z.object({
  key: keySchema,
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  type: z.literal("radio"),
  options: z.array(workflowRunInputOptionSchema),
  default: z.string().optional(),
  deriveFrom: z.never().optional(),
}).strict().superRefine((input, ctx) => {
  const values = input.options.map((option) => option.value);
  const valueSet = new Set(values);
  if (valueSet.size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "radio option values must be non-empty and unique",
    });
  }
  if (input.default !== undefined && !valueSet.has(input.default)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default"],
      message: "radio default must match a declared option value",
    });
  }
});

const checkboxBranchSchema = z.object({
  key: keySchema,
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  type: z.literal("checkbox"),
  options: z.array(workflowRunInputOptionSchema),
  default: z.array(z.string()).optional(),
  deriveFrom: z.never().optional(),
}).strict().superRefine((input, ctx) => {
  const values = input.options.map((option) => option.value);
  const valueSet = new Set(values);
  if (valueSet.size !== values.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "checkbox option values must be non-empty and unique",
    });
  }
  if (input.default !== undefined) {
    const defaultSet = new Set(input.default);
    if (defaultSet.size !== input.default.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "checkbox default values must be unique",
      });
    }
    for (const value of input.default) {
      if (!valueSet.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: "checkbox default must match declared option values",
        });
        break;
      }
    }
  }
});

const switchBranchSchema = z.object({
  key: keySchema,
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  type: z.literal("switch"),
  default: z.boolean().optional(),
  options: z.never().optional(),
  deriveFrom: z.never().optional(),
}).strict();

export type WorkflowRunInputText = z.infer<typeof textBranchSchema>;
export type WorkflowRunInputRadio = z.infer<typeof radioBranchSchema>;
export type WorkflowRunInputCheckbox = z.infer<typeof checkboxBranchSchema>;
export type WorkflowRunInputSwitch = z.infer<typeof switchBranchSchema>;

export type WorkflowRunInput =
  | WorkflowRunInputText
  | WorkflowRunInputRadio
  | WorkflowRunInputCheckbox
  | WorkflowRunInputSwitch;

export const workflowRunInputSchema = z.union([
  textBranchSchema,
  radioBranchSchema,
  checkboxBranchSchema,
  switchBranchSchema,
]) satisfies z.ZodType<WorkflowRunInput>;

export const workflowRunInputsSchema = z
  .array(workflowRunInputSchema)
  .max(5)
  .superRefine((inputs, ctx) => {
    const seen = new Set<string>();
    for (const [index, input] of inputs.entries()) {
      if (seen.has(input.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "key"],
          message: "run input keys must be unique",
        });
        continue;
      }
      seen.add(input.key);
    }
  }) satisfies z.ZodType<WorkflowRunInput[]>;
