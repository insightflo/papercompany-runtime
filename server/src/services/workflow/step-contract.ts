import type { WorkflowStepContract } from "@paperclipai/shared";

/**
 * [purpose] Step dispatch contract helpers — 발주 계약(사전조건/사후조건/미정의동작) 정규화.
 * 정의 stepsJson 은 zod 검증 없이 로드되는 legacy/plugin 정의도 있으므로,
 * 렌더·실행카드 기록 전에 이 방어적 정규화를 반드시 거친다(빈 항목 제거·트림·전부 비면 null).
 * [care] 규칙 8 — 계약은 지침·QA 검증 기준·구조 레코드일 뿐 실행 통제 권위가 아니다.
 * 런타임 코드가 계약 텍스트를 파싱해 성패/재시도/완료를 판정해서는 안 된다.
 */
export function normalizeWorkflowStepContract(raw: unknown): WorkflowStepContract | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const readSection = (key: string): string[] | undefined => {
    const value = record[key];
    if (!Array.isArray(value)) return undefined;
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  };
  const preconditions = readSection("preconditions");
  const postconditions = readSection("postconditions");
  const undefinedBehaviors = readSection("undefinedBehaviors");
  if (!preconditions && !postconditions && !undefinedBehaviors) return null;
  return {
    ...(preconditions ? { preconditions } : {}),
    ...(postconditions ? { postconditions } : {}),
    ...(undefinedBehaviors ? { undefinedBehaviors } : {}),
  };
}
