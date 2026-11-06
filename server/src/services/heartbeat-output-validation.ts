

export function canApplyMissingWorkProductRegistrationGate(issue: {
  originKind: string | null;
  title?: string | null;
  description?: string | null;
}, stepRunRequiresWorkProduct?: boolean) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  // workflow step의 명시 graphWorkProductRequired 플래그(workflow_step_runs.metadata에 stamp)가
  // 권위 source. present면 title/contract 휴리스틱을 무시한다.
  if (stepRunRequiresWorkProduct === true) return true;
  if (stepRunRequiresWorkProduct === false) return false;

  // Legacy fallback: 플래그 미스탬프 step-run(pre-deploy / 미동기화)용 종래 휴리스틱.
  const title = issue.title?.trim() ?? "";
  if (/\b(lead|approval|approve|audit|auditor|validator|validation|validate|verify|QA|review|check)\b/iu.test(title)) return false;
  if (hasDeliverableOutputContract(issue.description)) return true;
  return (
    /\b(synthesi[sz]e|synthesis|generate|produce|create|draft|artifact|document|note|infographic|export|deliver|html|pdf|report)\b/iu.test(title) ||
    /(작성|생성|제작|산출물|문서|자료|보고서|리포트|HTML|PDF)/u.test(title)
  );
}

function hasDeliverableOutputContract(description: string | null | undefined) {
  const text = description?.trim() ?? "";
  return text.includes("Deliverable output (use exactly this directory)") && /`?\[?ARTIFACT\]?`?\s*:/iu.test(text);
}

/**
 * workflow_step_runs.metadata 에서 graphWorkProductRequired 플래그를 3상으로 판정.
 * - true  → 명시 산출물 step (gate 발동)
 * - false → 명시 비산출물 step (gate 스킵, 휴리스틱도 무시)
 * - undefined → 필드 미스탬프(legacy row / metadata={} / non-boolean) → 종래 휴리스틱 fallback
 * buildWorkflowStepRunMetadata 가 항상 boolean 으로 stamp 하므로 non-boolean은 undefined 취급(legacy 호환).
 */
export function resolveStepRunRequiresWorkProduct(metadata: unknown): boolean | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).graphWorkProductRequired;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}
