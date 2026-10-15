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
    prose("- If the producer work-product file bytes were modified directly (for example to fix a QA finding), `retry_source_issue` will be rejected by generation and byte validation (`producer_rebind_bytes_changed`). Submit `adopt_producer_edits` with your measured attestation, rerun the producer step, or register a corrected revision through the official producer registration path; if none is possible from this card, submit `request_input` or `escalate` so a human operator can decide.",
      "- 생산자 산출물 파일 바이트를 직접 수정했다면(예: QA 지적 수정) `retry_source_issue`는 세대·바이트 검증에서 거부됩니다(`producer_rebind_bytes_changed`). 측정한 증명과 함께 `adopt_producer_edits`를 제출하거나, 생산 단계를 다시 실행하거나, 공식 등록 절차로 수정본을 새 생산자 버전으로 등록하세요. 이 카드에서 어느 것도 불가능하면 `request_input` 또는 `escalate`를 제출해 운영자 판단을 받으세요."),
    "",
    "Mission owner decision authority:",
    prose("- Submit the recovery decision through `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`; a comment cannot authorize recovery.",
      "- `POST /api/issues/{this owner-action issue id}/owner-recovery/decision`으로 결정을 제출하세요. 댓글은 복구를 승인할 수 없습니다."),
    prose("- For recorded `workproduct_selector_provenance_missing`, use `mission_owner_execute` operation `promote_unblock_product` with productId, producerStepId and the exact tool_step recoveryTarget above. Only your own prior mission_owner_unblock_source product in this mission is eligible. Promotion and native retry commit together; a refused retry rolls promotion back. Existing six operations, board promotion and QA remain unchanged. Producer IDs are in the structured system facts; this guidance is not authority.",
      "- 기록된 workproduct_selector_provenance_missing 복구에는 mission_owner_execute의 promote_unblock_product를 사용하세요. productId, producerStepId와 위의 정확한 tool_step recoveryTarget이 필요합니다. 이 미션에서 본인이 수행한 기존 mission_owner_unblock_source 산출물만 가능합니다. 승격과 기존 재시도가 함께 적용되고, 재시도 거부 시 승격도 취소됩니다. 기존 여섯 작업·보드 승격·QA는 유지됩니다. 생산자 ID는 구조화된 사실에 있으며, 이 안내 자체는 실행 권한이 아닙니다."),
    prose("- `request_input` and `escalate` submitted through that API create the Human Operator handoff.",
      "- 이 API에 제출한 request_input/escalate는 운영자 요청을 생성하며 도구를 재시도하지 않습니다."),
    prose("- For a recorded `producer_rebind_bytes_changed` fence, use the `mission_owner_execute` operation `adopt_producer_edits` with the productId and producerStepId from the structured facts above and an attestation {sha256, byteSize} you measured over the edited file. The server re-measures the file and adopts it only on an exact match. Adoption and the exact retry commit together; a refused retry rolls the adoption back. Existing operations, board rebind and QA remain unchanged.",
      "- 기록된 producer_rebind_bytes_changed 펜스에는 mission_owner_execute의 adopt_producer_edits를 사용하세요(위 구조화된 사실의 productId·producerStepId와 수정 파일에서 직접 측정한 attestation{sha256, byteSize}). 서버가 파일을 재측정해 정확히 일치할 때만 채택합니다. 채택과 정확한 재시도가 함께 적용되고 재시도 거부 시 채택도 취소됩니다. 기존 작업·보드 재바인딩·QA는 유지됩니다."),
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
