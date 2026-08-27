import type { WorkflowRunInputOption } from "./workflow-page-types.js";

export type WorkflowRunInputPrompt = (message: string, defaultValue?: string) => string | null;

export type WorkflowRunInputCollection =
  | { status: "ready"; metadata: Record<string, string> }
  | { status: "cancelled" }
  | { status: "missing_required"; key: string; label: string };

/**
 * 실행 입력(runInputs) 선언이 있으면 프롬프트로 값을 하나씩 수집한다.
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
  for (const input of runInputs) {
    const label = input.label?.trim() || input.key;
    const value = prompt(label, input.placeholder ?? "");
    if (value === null) return { status: "cancelled" };
    const trimmed = value.trim();
    const required = input.required !== false;
    if (required && trimmed === "") return { status: "missing_required", key: input.key, label };
    if (trimmed !== "") metadata[input.key] = trimmed;
  }
  return { status: "ready", metadata };
}
