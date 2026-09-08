import {
  applyWorkflowRunInputDefaults,
  validateWorkflowRunInputValues,
  type WorkflowRunInputErrorDetails,
  type WorkflowRunInputFieldError,
} from "@paperclipai/shared/workflow-run-input-values";
import type { WorkflowRunInput } from "./types.js";
import { applyRunInputDerivations } from "./run-input-derivations.js";

/**
 * [purpose] 실행 입력(runInputs) 정규화 순수 함수: 기본값 적용 → 파생 추출 → 값 검증을
 * 단일 선언-순서 패스로 수행하고, 실패를 구조화 필드 오류로 보고한다.
 * [care] 규칙 8·9 — 오류는 machine-produced `details.fieldErrors`(key/code/message)다.
 * message·Error 문장은 표시용이며 파싱 대상이 아니다. 흐름 제어는 항상 key/code 필드로.
 * 입력(metadata·선언)은 변경하지 않는다(기본값·파생 단계 모두 복사본을 만든다).
 * 이 모듈은 큐/런/스케줄/승인 실행 의미를 건드리지 않는다.
 */

export type WorkflowRunInputPolicy = { legacyTextRequired?: boolean };

export class WorkflowRunInputValidationError extends Error {
  readonly details: WorkflowRunInputErrorDetails;

  constructor(fieldErrors: WorkflowRunInputFieldError[]) {
    super("Invalid workflow run input values");
    this.name = "WorkflowRunInputValidationError";
    this.details = { version: 1, code: "invalid_workflow_run_inputs", fieldErrors };
  }
}

/**
 * 실행 입력 정규화 단일 패스:
 * 1) 누락/undefined 키에만 선언 기본값을 적용한다(명시적 false/[]는 보존).
 * 2) 선언 순서대로 파생 입력을 한 번씩 처리한다(사용자 제공 비공란 값 우선, 실패 시
 *    required 파생은 구조화 에러, 선택 파생은 기존 동작대로 삭제).
 * 3) 파생된 메타데이터를 값 계약으로 검증한다(협조/강제 변환 없이 key/code 오류).
 * policy는 레거시 text 필수 여부만 선택적으로 강제한다(웹훅 요청 전용 내부 정책).
 */
export function normalizeWorkflowRunInputs(
  inputs: readonly WorkflowRunInput[] | undefined,
  metadata: Record<string, unknown> | undefined,
  policy?: WorkflowRunInputPolicy,
): Record<string, unknown> {
  const defaults = applyWorkflowRunInputDefaults(inputs, metadata);
  const derived = applyRunInputDerivations(inputs, defaults);
  if (derived.status === "error") {
    throw new WorkflowRunInputValidationError([
      { key: derived.key, code: "derivation_failed", message: derived.message },
    ]);
  }
  const errors = validateWorkflowRunInputValues(inputs, derived.metadata, policy);
  if (errors.length) throw new WorkflowRunInputValidationError(errors);
  return derived.metadata;
}
