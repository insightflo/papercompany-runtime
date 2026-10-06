// Display-only wrappers. Raw evidence, identifiers and authority records are never rewritten.
import type { SystemLanguage } from "./system-language.js";
export { loadCompanySystemLanguage } from "./system-language.js";
const text = (language: SystemLanguage, ko: string, en: string) => language === "ko" ? ko : en;

export function buildPlanQaResultComment(input: {
  language: SystemLanguage; verdict: string; diagnostics?: Array<Record<string, unknown>>; decisionHash: string;
}): string {
  const reason = input.diagnostics?.map(d => d.message ?? d.code ?? "").filter(Boolean).join("; ");
  return [
    text(input.language, "## 계획 검토 결과를 기록했습니다", "## Plan review result recorded"),
    input.verdict === "pass" ? "PASS" : `REQUEST_CHANGES: ${reason || "needs work"}`,
    text(input.language, "기본 검토 결과이며 최종 승인을 뜻하지 않습니다. 최종 판단은 구조화된 검증 기록에서 확인해 주세요.", "This is a base review result, not final approval. Check the structured gate record for the final decision."),
    text(input.language, input.verdict === "pass" ? "다음 행동: 추가 검증과 근거 제출이 충족됐는지 확인해 주세요." : "다음 행동: 지적된 부분을 수정하고 계획과 검증 근거를 다시 제출해 주세요.", input.verdict === "pass" ? "Next action: check that required additional checks and evidence submissions are satisfied." : "Next action: fix the reported gaps and resubmit the plan and verification evidence."),
    `- decisionHash: ${input.decisionHash}`,
  ].join("\n");
}

export function buildAdoptionNotification(input: {
  language: SystemLanguage; resolvedRef: string; operation: string; section: string;
  gateOwner: string | null | undefined; candidateHash: string | null | undefined;
  contentHashBefore: string; contentHashAfter: string; producerAgentId: string | null | undefined;
}): string {
  return [
    text(input.language, "자기개선 채택이 적용되었습니다 (system notification).", "Self-improvement adoption applied (system notification)."),
    text(input.language, "다음 행동: 아래 스킬과 변경 전후 기록을 확인해 주세요. 이 알림은 새 실행을 요청하지 않습니다.", "Next action: review the skill and before/after records below. This notification does not request another run."),
    `- ${text(input.language, "스킬", "Skill")}: ${input.resolvedRef}`,
    `- ${text(input.language, "작업", "Operation")}: ${input.operation} — ${input.section}`,
    `- ${text(input.language, "게이트 오너", "Gate owner")}: ${input.gateOwner ?? "unknown"}`,
    `- ${text(input.language, "후보 해시", "Candidate hash")}: ${input.candidateHash ?? "unknown"}`,
    `- ${text(input.language, "적용 전 내용 해시", "Content hash before")}: ${input.contentHashBefore}`,
    `- ${text(input.language, "적용 후 내용 해시", "Content hash after")}: ${input.contentHashAfter}`,
    `- ${text(input.language, "생산자 에이전트", "Producer agent")}: ${input.producerAgentId ?? "unknown"}`,
  ].join("\n");
}

export function buildRecoveryDraft(input: {
  language: SystemLanguage; kind: "producer_rework" | "qa_recheck"; producerLabel: string; qaLabel: string; leafCause?: string;
}): string {
  const { language, producerLabel, qaLabel } = input;
  return [
    text(language, input.kind === "producer_rework" ? "재작업 요청 초안입니다. 실행 요청은 아직 하지 않았습니다." : "QA 재검 요청 초안입니다. 실행 요청은 아직 하지 않았습니다.", input.kind === "producer_rework" ? "Producer rework draft; not dispatched." : "QA recheck draft; not dispatched."),
    input.kind === "producer_rework"
      ? text(language, `QA 이슈(${qaLabel})에서 수정이 필요하다고 판정했습니다. 억지로 PASS 처리하지 말고 ${producerLabel}의 산출물을 고쳐 주세요.`, `QA issue ${qaLabel} requested changes. Do not force PASS; revise the work products on ${producerLabel}.`)
      : text(language, `생산 업무(${producerLabel})가 산출물을 수정한 뒤 workflow complete를 호출했습니다. QA 이슈(${qaLabel})를 다시 실행해 검토해 주세요.`, `Producer ${producerLabel} updated its work products and called workflow complete. Request a recheck on QA issue ${qaLabel}.`),
    input.leafCause ? `${text(language, "QA가 지적한 사유", "QA reason")}: ${input.leafCause}` : "",
    text(language, input.kind === "producer_rework" ? "다음 행동: 수정 후 산출물(workProduct)을 다시 등록하고 workflow complete를 호출한 뒤 QA 재검을 요청해 주세요." : "다음 행동: 생산자가 더 수정하기 전에 QA가 검증 결과(verdict)를 제출해야 합니다.", input.kind === "producer_rework" ? "Next action: register the revised workProduct, call workflow complete, then request QA recheck." : "Next action: QA must submit its verdict before the producer makes further changes."),
  ].filter(Boolean).join("\n\n");
}

export function buildTerminalCloseoutComment(input: {
  language: SystemLanguage; sourceIssueId?: string; sourceStatus?: string; terminalDecisionId?: string;
}): string {
  return input.terminalDecisionId
    ? text(input.language, `종결 결정 ${input.terminalDecisionId}에 따라 복구 업무를 취소(cancelled)했습니다. 작업 흐름이 종결되어 더 이상 열린 업무가 아닙니다. 다음 행동: 종결 결정과 최종 기록을 확인해 주세요. 새 실행을 요청하지 않습니다.`, `Superseded (cancelled) by workflow terminal decision ${input.terminalDecisionId}: this owner action no longer represents open mission work after the run was finalized. Next action: review the terminal decision and final records; this does not request another run.`)
    : text(input.language, `복구 업무를 자동으로 정리했습니다. 원래 업무 ${input.sourceIssueId}의 상태는 ${input.sourceStatus}이며 더 이상 열린 미션 업무가 아닙니다. 다음 행동: 원래 업무의 최종 기록을 확인해 주세요. 새 실행을 요청하지 않습니다.`, `Resolved automatically: source issue ${input.sourceIssueId} reached ${input.sourceStatus}; this unblock action no longer represents open mission work. Next action: review the source issue's final record; this does not request another run.`);
}
