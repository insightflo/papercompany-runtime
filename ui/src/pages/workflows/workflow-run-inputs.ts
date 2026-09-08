import {
  applyWorkflowRunInputDefaults,
  validateWorkflowRunInputValues,
  type WorkflowRunInputFieldError,
} from "@paperclipai/shared/workflow-run-input-values";
import type { WorkflowRunInputOption } from "./workflow-page-types.js";

/**
 * [purpose] 실행 팝업 입력값(run input values)의 화면 측 계약: 선언된 runInputs로 초기
 * draft를 만들고, 제출 전에 trim·생략·검증을 적용한 제출 메타데이터를 만든다.
 * [care] 규칙 8·9 — 필드 식별·흐름 제어는 key/code 필드만 사용한다(오류 message는 표시용).
 * 검증은 공유 값 계약(applyWorkflowRunInputDefaults → validateWorkflowRunInputValues)을
 * 그대로 적용하며, 이 모듈은 브라우저 프롬프트(window.prompt)를 사용하지 않는다.
 * 파생(deriveFrom) 입력은 서버가 소스 값에서 계산하므로 draft·제출 어디에도 넣지 않는다.
 */

export type WorkflowRunInputDraft = Record<string, string | string[] | boolean>;

export type WorkflowRunSubmission = { runLabel?: string; metadata: WorkflowRunInputDraft };

/**
 * 선언에서 초기 draft를 만든다.
 * - text: placeholder ?? "" (trim은 제출 시점)
 * - switch: default ?? false (false 보존 — falsy 기본값도 값이다)
 * - radio: 선언된 default가 있을 때만 선택(기본값을 꾸며내지 않는다)
 * - checkbox: default 배열을 복제해 넣고, 기본값이 없으면 상호작용 전까지 부재(미선택 렌더)
 * - 파생 입력: 입력칸이 없으므로 draft에 넣지 않는다
 * 입력 선언과 배열은 변경하지 않는다(checkbox default는 복제).
 */
export function initialWorkflowRunInputDraft(inputs: readonly WorkflowRunInputOption[]): WorkflowRunInputDraft {
  // Declared keys such as "__proto__" must remain ordinary own fields.
  const draft: WorkflowRunInputDraft = Object.create(null);
  for (const input of inputs) {
    if (input.deriveFrom) continue;
    if (input.type === "radio") {
      if (input.default !== undefined) draft[input.key] = input.default;
      continue;
    }
    if (input.type === "switch") {
      draft[input.key] = input.default ?? false;
      continue;
    }
    if (input.type === "checkbox") {
      if (input.default !== undefined) draft[input.key] = [...input.default];
      continue;
    }
    draft[input.key] = input.placeholder ?? "";
  }
  return draft;
}

/**
 * draft를 제출 메타데이터로 수집한다.
 * - text만 trim하고, 선택적 공란 text는 생략(빈 키 전달 방지). 필수 공란은 required 오류.
 * - string[]/boolean(빈 배열 [] 포함)은 그대로 보존한다 — 명시적 선택·해제 결과를 지우지 않는다.
 * - 파생 입력은 절대 메타데이터에 넣지 않는다.
 * - 공유 기본값 적용 후 공유 신규형 검증기를 적용한다(서버 정규화와 동일한 값 계약).
 */
export function collectWorkflowRunInputDraft(
  inputs: readonly WorkflowRunInputOption[],
  draft: WorkflowRunInputDraft,
): { status: "ready"; metadata: WorkflowRunInputDraft } | { status: "error"; fieldErrors: WorkflowRunInputFieldError[] } {
  // 파생 입력은 서버가 소스 값에서 계산하므로 클라이언트 수집·검증 대상에서 제외한다.
  const declared = inputs.filter((input) => !input.deriveFrom);
  const metadata: WorkflowRunInputDraft = Object.create(null);
  for (const input of declared) {
    if (!Object.hasOwn(draft, input.key)) continue;
    const value = draft[input.key];
    if ((input.type === undefined || input.type === "text") && typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" && input.required === false) continue;
      metadata[input.key] = trimmed;
      continue;
    }
    // text가 아닌 값(radio 문자열·checkbox 배열·switch boolean)은 trim하지 않고 그대로 보존한다.
    metadata[input.key] = value;
  }
  const defaulted = applyWorkflowRunInputDefaults(declared, metadata);
  // Shared defaults copy into a plain object; inherited names are not text input values.
  Object.setPrototypeOf(defaulted, null);
  const fieldErrors = validateWorkflowRunInputValues(declared, defaulted, { legacyTextRequired: true });
  if (fieldErrors.length > 0) return { status: "error", fieldErrors };
  return { status: "ready", metadata: defaulted as WorkflowRunInputDraft };
}
