import type { WorkflowRunInputOption } from "./workflow-page-types.js";

export type WorkflowRunInputPrompt = (message: string, defaultValue?: string) => string | null;

export type WorkflowRunInputCollection =
  | { status: "ready"; metadata: Record<string, string>; derivedNote: string | null }
  | { status: "cancelled" }
  | { status: "missing_required"; key: string; label: string };

/**
 * 실행 입력(runInputs) 선언이 있으면 프롬프트로 값을 하나씩 수집한다.
 * - deriveFrom 파생 입력은 입력칸을 렌더하지 않는다(서버가 소스 값에서 계산) —
 *   파생 입력이 있으면 derivedNote로 안내 문구를 돌려준다.
 * - 취소(null) → cancelled (실행 중단, 에러 아님)
 * - required(기본 true)인데 빈 값 → missing_required (실행 중단)
 * - optional 빈 값 → 메타데이터에서 제외(빈 키 전달 방지)
 * 선언이 없으면 호출 자체를 하지 않는다(즉시 실행 기존 동작).
 */
export function collectWorkflowRunInputs(
  runInputs: readonly WorkflowRunInputOption[],
  prompt: WorkflowRunInputPrompt,
): WorkflowRunInputCollection {
  const metadata: Record<string, string> = {};
  const derivedLabels: string[] = [];
  for (const input of runInputs) {
    if (input.deriveFrom) {
      derivedLabels.push(input.label?.trim() || input.key);
      continue;
    }
    const label = input.label?.trim() || input.key;
    const value = prompt(label, input.placeholder ?? "");
    if (value === null) return { status: "cancelled" };
    const trimmed = value.trim();
    const required = input.required !== false;
    if (required && trimmed === "") return { status: "missing_required", key: input.key, label };
    if (trimmed !== "") metadata[input.key] = trimmed;
  }
  const derivedNote = derivedLabels.length > 0
    ? `${derivedLabels.join(", ")} 값은 자동으로 추출됩니다`
    : null;
  return { status: "ready", metadata, derivedNote };
}

export type ManualRunLabelCollection =
  | { status: "ready"; runLabel: string | null }
  | { status: "cancelled" };

/**
 * [manual run label] 수동 실행 “실행명”은 입력변수(runInputs)와 구분되는 실행 차원의 이름이다.
 * 값이 있으면 runLabel 로 전송되어 미션명에 접미되고, 비우면 생략된다.
 * 취소(null) → cancelled (실행 중단, 실행 입력 취소와 동일 규칙).
 */
export function collectManualRunLabel(prompt: WorkflowRunInputPrompt): ManualRunLabelCollection {
  const value = prompt("실행명 (선택) — 미션명에 붙어 같은 날 반복 실행을 구분합니다. 비우면 생략", "");
  if (value === null) return { status: "cancelled" };
  const trimmed = value.trim();
  return { status: "ready", runLabel: trimmed === "" ? null : trimmed };
}
