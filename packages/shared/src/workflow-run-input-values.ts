import { z } from "zod";
import type { WorkflowRunInput } from "./validators/workflow-run-inputs.js";

/**
 * [purpose] 워크플로 실행 입력 값(value) 계약: 선언된 runInputs에 대한 기본값 적용과
 * 응답 검증을 순수 함수로 제공한다. 정의(declaration) 계약은 validators/workflow-run-inputs.
 * [care] 규칙 8·9 — 이 모듈은 machine-produced 필드 오류(key/code/message)를 만든다.
 * 오류 문장은 표시용이며 파싱 대상이 아니다. 필드 식별·흐름 제어는 항상 key/code 필드를
 * 사용한다. 함수는 입력(metadata·선언·default 배열)을 변경하지 않는다.
 */

export type WorkflowRunInputFieldErrorCode =
  | "required"
  | "invalid_type"
  | "invalid_option"
  | "duplicate_value"
  | "derivation_failed";

export type WorkflowRunInputFieldError = {
  key: string;
  code: WorkflowRunInputFieldErrorCode;
  message: string;
};

export type WorkflowRunInputErrorDetails = {
  version: 1;
  code: "invalid_workflow_run_inputs";
  fieldErrors: WorkflowRunInputFieldError[];
};

export const workflowRunInputErrorDetailsSchema = z.object({
  version: z.literal(1),
  code: z.literal("invalid_workflow_run_inputs"),
  fieldErrors: z.array(
    z.object({
      key: z.string().min(1),
      code: z.enum([
        "required",
        "invalid_type",
        "invalid_option",
        "duplicate_value",
        "derivation_failed",
      ]),
      message: z.string().min(1),
    }).strict(),
  ),
}).strict();

const FIELD_ERROR_MESSAGE: Record<WorkflowRunInputFieldErrorCode, (label: string) => string> = {
  required: (label) => `'${label}' 항목은 필수 입력입니다.`,
  invalid_type: (label) => `'${label}' 항목 값의 형식이 올바르지 않습니다.`,
  invalid_option: (label) => `'${label}' 항목 값이 선택 목록에 없습니다.`,
  duplicate_value: (label) => `'${label}' 항목에 중복된 값이 포함되어 있습니다.`,
  derivation_failed: (label) => `'${label}' 항목 값을 자동으로 추출하지 못했습니다.`,
};

function buildFieldError(input: WorkflowRunInput, code: WorkflowRunInputFieldErrorCode): WorkflowRunInputFieldError {
  const label = input.label ?? input.key;
  return { key: input.key, code, message: FIELD_ERROR_MESSAGE[code](label) };
}

export function applyWorkflowRunInputDefaults(
  inputs: readonly WorkflowRunInput[] | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  for (const input of inputs ?? []) {
    const missing = !Object.hasOwn(next, input.key) || next[input.key] === undefined;
    if (input.type && input.type !== "text" && missing && input.default !== undefined) {
      // defineProperty: "__proto__" 같은 키도 자기 속성으로 안전하게 설정한다.
      Object.defineProperty(next, input.key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: Array.isArray(input.default) ? [...input.default] : input.default,
      });
    }
  }
  return next;
}

function isPresent(metadata: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(metadata, key) && metadata[key] !== undefined;
}

export function validateWorkflowRunInputValues(
  inputs: readonly WorkflowRunInput[] | undefined,
  metadata: Record<string, unknown>,
  options?: { legacyTextRequired?: boolean },
): WorkflowRunInputFieldError[] {
  const errors: WorkflowRunInputFieldError[] = [];
  for (const input of inputs ?? []) {
    if (input.type === undefined || input.type === "text") {
      // 레거시 웹훅 text 필수 검사(requireWebhookRunInputs)와 동일한 presence 규칙:
      // 문자열은 trim 비어있지 않아야 하고, 비문자열은 null/undefined가 아니면 존재로 본다.
      if (options?.legacyTextRequired === true && input.required !== false) {
        const value = metadata[input.key];
        const present = typeof value === "string" ? value.trim().length > 0 : value != null;
        if (!present) errors.push(buildFieldError(input, "required"));
      }
      continue;
    }
    if (!isPresent(metadata, input.key)) {
      if (input.required !== false) errors.push(buildFieldError(input, "required"));
      continue;
    }
    const value = metadata[input.key];
    switch (input.type) {
      case "switch": {
        if (typeof value !== "boolean") errors.push(buildFieldError(input, "invalid_type"));
        break;
      }
      case "radio": {
        if (typeof value !== "string") {
          errors.push(buildFieldError(input, "invalid_type"));
          break;
        }
        const optionSet = new Set(input.options.map((option) => option.value));
        if (!optionSet.has(value)) errors.push(buildFieldError(input, "invalid_option"));
        break;
      }
      case "checkbox": {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          errors.push(buildFieldError(input, "invalid_type"));
          break;
        }
        const items = value as string[];
        if (new Set(items).size !== items.length) {
          errors.push(buildFieldError(input, "duplicate_value"));
          break;
        }
        const optionSet = new Set(input.options.map((option) => option.value));
        if (items.some((item) => !optionSet.has(item))) {
          errors.push(buildFieldError(input, "invalid_option"));
          break;
        }
        if (input.required !== false && items.length === 0) {
          errors.push(buildFieldError(input, "required"));
        }
        break;
      }
    }
  }
  return errors;
}
