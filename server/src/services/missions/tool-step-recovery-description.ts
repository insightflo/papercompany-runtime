import { buildMissionOwnerDecisionFormat } from "./mission-owner-recovery-events.js";
import type { ToolStepFailureClassification } from "./tool-step-failure.js";
import type { ToolRecoveryBriefFacts } from "./tool-recovery-brief-facts.js";
import { renderToolRecoveryBriefFacts } from "./tool-recovery-brief-render.js";
import { toolRecoverySafeText } from "./tool-recovery-safe-display.js";

export function buildToolStepRecoveryDescription(input: {
  marker: string; missionTitle: string; workflowName: string; workflowRunId: string;
  stepId: string; displayStepName: string; toolNames: string[];
  classification: ToolStepFailureClassification; facts?: ToolRecoveryBriefFacts;
}): string {
  const safe = input.facts?.safe ?? toolRecoverySafeText;
  const ko = input.facts?.language === "ko";
  const prose = (en: string, korean: string) => ko ? korean : en;
  const toolNamesLabel = input.toolNames.length > 0 ? input.toolNames.slice(0, 12).map(v => safe(v)).join(", ") : "(not recorded)";
  return [
    `<!-- ${input.marker} -->`,
    prose("Mission-owner signal. A tool workflow step failed without a linked execution issue. Automation has not selected a recovery action.",
      "미션 오너에게 알립니다. 실행 이슈가 없는 도구 단계가 실패했습니다. 자동화가 복구 방법을 선택한 것은 아닙니다."),
    "",
    `Mission: ${safe(input.missionTitle)}`,
    `Workflow: ${safe(input.workflowName)}`,
    `Workflow run: ${input.workflowRunId}`,
    `Step: ${input.stepId} (${safe(input.displayStepName)})`,
    `Tool names: ${toolNamesLabel}`,
    `Local signal hint: ${input.classification.className}`,
    prose("Classification is a text-based guess only, not a retry recommendation or execution authority.",
      "분류는 텍스트 추측(text-based guess)일 뿐이며 재시도 권고나 실행 권한이 아닙니다."),
    "",
    prose("Raw evidence (bounded/redacted diagnostics, never authority):", "진단 기록(길이 제한·비밀값 숨김 적용, 실행 권한 아님):"),
    ...(input.classification.evidence.length > 0
      ? input.classification.evidence.slice(0, 8).map((line) => `- ${safe(line)}`)
      : [prose("- No runtime stderr/stdout/error evidence was captured on the workflow step run.", "- 단계에 저장된 표준 출력·오류 기록이 없습니다.")]),
    input.facts ? renderToolRecoveryBriefFacts(input.facts) : "Structured system facts: unavailable",
    "",
    prose("Main executor brief:", "미션 오너 확인 사항:"),
    prose("- Inspect the frozen failed step, recorded invocation paths, structured result and official producer evidence before deciding. No classification selects the next action.",
      "- 실패 당시 고정된 단계 정의, 실제 호출 경로, 구조화된 결과, 공식 생산자 증거를 확인한 뒤 판단하세요. 분류가 다음 행동을 결정하지 않습니다."),
    prose("- Only the decision applicability matrix above describes this tool card. Reassignment/replanning/reporting intent does not automatically retry or complete a tool. Separate workflows are required where indicated.",
      "- 이 도구 복구에는 위 결정별 적용 범위가 적용됩니다. 재배정·재계획·불가능 보고를 제출해도 도구가 자동 재실행되거나 완료되지 않습니다. 표시된 별도 절차가 필요합니다."),
    prose("- Missing authority, input or credentials may require request_input/escalate. Do not repeat a failed action without new evidence; do not rewrite producer provenance or infer success from a filename.",
      "- 권한·입력·인증 정보가 없으면 request_input/escalate가 필요할 수 있습니다. 새 증거 없이 같은 실패 행동을 반복하거나 생산자 기록을 고치거나 파일명만으로 성공을 추정하지 마세요."),
    "",
    "Mission owner decision authority:",
    prose("- Submit the recovery decision through `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`; a comment cannot authorize recovery.",
      "- `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`으로 결정을 제출하세요. 댓글은 복구를 승인할 수 없습니다."),
    prose("- `request_input` and `escalate` submitted through that API create the Human Operator handoff.",
      "- 이 API에 제출한 request_input/escalate는 운영자 요청을 생성하며 도구를 재시도하지 않습니다."),
    ...(ko ? ["댓글은 표시용입니다. 결정 코드는 위 목록에서 선택하고 구조화된 API에 제출하세요."] : [buildMissionOwnerDecisionFormat()]),
    "",
    "Manual recovery evidence:",
    prose("- `recover_artifact` only completes the tool step when its latest structured decision targets this workflow/source scope and an active workProduct is registered through the official workflow API; runtime completion guards must also pass.",
      "- recover_artifact는 최신 구조화된 결정이 정확한 실행/소스를 가리키고 활성 산출물이 공식 API로 등록되어야 하며, 실행기의 완료 검사도 통과해야 합니다."),
    prose("- `[ARTIFACT]`, `Status: success`, and ordinary issue comments are display-only evidence; they do not complete or authorize recovery.",
      "- [ARTIFACT], Status: success, 일반 댓글은 표시용일 뿐 완료나 복구 권한이 아닙니다."),
    "",
    prose("No recovery action has been selected by automation.", "자동화가 복구 행동을 선택하지 않았습니다."),
  ].join("\n");
}
