import type { workflowRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { normalizeWorkflowStepContract } from "./step-contract.js";
import { renderWorkflowRunTextTemplate } from "./dag-run-text-template.js";

export function buildWorkflowApiCloseoutLines(input: {
  requiresWorkProduct: boolean;
  requiresVerdict: boolean;
}): string[] {
  const lines = [
    "Workflow API closeout:",
    "- Use the installed `paperclip` skill for request examples and Paperclip API environment variables.",
  ];
  if (input.requiresWorkProduct) {
    lines.push("- If this step creates or reuses a file artifact, register it with `POST /api/issues/{issueId}/workflow/artifacts` before completion.");
    lines.push("- If this step publishes a public URL, register it with `POST /api/issues/{issueId}/workflow/artifacts` using `type: \"preview_url\"` and `url` before completion.");
  }
  if (input.requiresVerdict) {
    lines.push("- Submit the official `PASS`, `REQUEST_CHANGES`, or `INSUFFICIENT_EVIDENCE` verdict with `POST /api/issues/{issueId}/workflow/verdict` before completion.");
    lines.push("- `REQUEST_CHANGES` requires `findings`: one entry per blocking defect with `id`, `summary`, `layer` (`artifact` = the produced deliverable, `source_data` = upstream source data). Example: `{\"verdict\":\"request_changes\",\"findings\":[{\"id\":\"F1\",\"summary\":\"...\",\"layer\":\"artifact\"}]}`. Keep `reason` concise.");
    lines.push("- On re-review, reuse the same finding id when the same defect persists — recurring findings are automatically promoted to source_data routing (producer rework budget is not consumed for them).");
    lines.push("- `REQUEST_CHANGES` may attach `remediations` only when every defect is a purely mechanical string replacement in a registered work-product file: items `{op:\"string_replace\", file, find, replace}` (max 20; `find` must occur exactly once in the file). The control plane patches and re-runs this validation — no producer rework. Non-mechanical defects: no `remediations`.");
    lines.push("- Use `INSUFFICIENT_EVIDENCE` only when the evidence needed to judge is genuinely missing; list what is missing in `reason` (required). It records an abstention — it does not satisfy this gate and does not trigger producer rework.");
  }
  lines.push("- Complete this workflow issue with `POST /api/issues/{issueId}/workflow/complete` after required artifact or verdict records exist.");
  lines.push("- Use normal issue status/comment updates only if the Workflow API is unavailable or the issue is blocked.");
  return lines;
}

/**
 * [B안 스텝 계약] 발주 이슈 지침에 들어갈 계약 섹션 렌더.
 * 사전조건=시작 전 확인(불충족 시 blocked 보고), 사후조건=완료 전 성립 확인,
 * 미정의동작=결과 보장 없음(추측 금지·정지 보고). 계약은 지침·검증 기준일 뿐
 * 실행 통제 권위가 아니다(규칙 8) — 완료 판정은 기존 workProduct/verdict 게이트가 한다.
 */
export function buildStepContractDescriptionLines(input: {
  contract: unknown;
  run: typeof workflowRuns.$inferSelect;
}): string[] {
  const contract = normalizeWorkflowStepContract(input.contract);
  if (!contract) return [];
  const render = (item: string) => renderWorkflowRunTextTemplate(item, input.run);
  const lines: string[] = [
    "Step contract:",
    "- The workflow owner recorded the contract below for this step. Verify it yourself; do not treat it as already checked.",
  ];
  if (contract.preconditions?.length) {
    lines.push("Preconditions (verify before starting; report blocked if unmet):");
    for (const item of contract.preconditions) lines.push(`- ${render(item)}`);
  }
  if (contract.postconditions?.length) {
    lines.push("Postconditions (must hold when you mark this step complete):");
    for (const item of contract.postconditions) lines.push(`- ${render(item)}`);
  }
  if (contract.undefinedBehaviors?.length) {
    lines.push("Undefined behaviors (outcome is NOT guaranteed; stop and report instead of guessing):");
    for (const item of contract.undefinedBehaviors) lines.push(`- ${render(item)}`);
  }
  lines.push("");
  return lines;
}

/**
 * [B안 스텝 계약] QA 루브릭의 의존 스텝 계약 섹션 라인.
 * QA는 의존 workProduct를 생산자가 기록한 계약 기준으로 평가한다(사후조건 우선, 미정의동작 병기).
 */
export function buildDependencyStepContractLines(input: {
  dependencyRows: Array<{ stepId: string }>;
  workflowStepsById: Map<string, WorkflowStep>;
}): string[] {
  const lines: string[] = [];
  for (const row of input.dependencyRows) {
    const step = input.workflowStepsById.get(row.stepId);
    if (!step) continue;
    const contract = normalizeWorkflowStepContract(step.contract);
    if (!contract) continue;
    lines.push(`- ${row.stepId}:`);
    if (contract.postconditions?.length) {
      lines.push(`  postconditions: ${contract.postconditions.join("; ")}`);
    }
    if (contract.undefinedBehaviors?.length) {
      lines.push(`  undefined behaviors: ${contract.undefinedBehaviors.join("; ")}`);
    }
    if (!contract.postconditions?.length && !contract.undefinedBehaviors?.length && contract.preconditions?.length) {
      lines.push(`  preconditions: ${contract.preconditions.join("; ")}`);
    }
  }
  return lines;
}
