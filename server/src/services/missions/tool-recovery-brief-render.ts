import type { ToolRecoveryBriefFacts } from "./tool-recovery-brief-facts.js";

export function renderToolRecoveryBriefFacts(facts: ToolRecoveryBriefFacts): string {
  const ko = facts.language === "ko";
  return [
    ko ? "## 구조화된 시스템 사실" : "## Structured system facts",
    ko ? "생성 시점의 읽기 전용 기록입니다. 제출 가능성, 실행 가능성, 실제 실행 권한은 서로 다릅니다. 이 설명은 실행 권한이 아닙니다."
      : "Read-only creation snapshot. Accepted submission, applicability and execution authority differ. This brief is display only, never execution authority.",
    "recoveryTarget:", "```json", JSON.stringify(facts.recoveryTarget, null, 2), "```",
    ko ? "현재 미션 오너 에이전트의 이 복구 이슈 실행/체크아웃이 필요합니다. 운영자는 오너를 대신해 결정을 제출할 수 없습니다."
      : "Submission requires the current mission-owner agent's heartbeat and checkout on this owner-action issue; board cannot submit as owner.",
    ko ? "재시도와 산출물 복구는 잠금 안에서 최신 결정과 증거를 다시 확인합니다. 처음부터 재시작은 별도 운영자 승인(board approval)이 필요합니다."
      : "Retry and artifact recovery revalidate latest decision and evidence under locks. restart_from_start needs separate board approval and owner admission.",
    ...(["submission", "execution", "decisions", "registration", "registry", "toolResult", "invocationPaths", "producers", "relatedPatterns", "languageLookup"] as const)
      .map(key => `${key}: ${JSON.stringify(facts[key])}`),
    ko ? "toolResult.error는 실행기가 저장한 오류 설명이며 오류 코드나 실행 권한이 아닙니다. recover_artifact에는 reworkTargetRef(우선) 또는 sourceIssueRef로 공식 산출물을 소유한 같은 회사·미션의 생산자 이슈 ID/식별자를 지정하세요. recoveryTarget은 실패한 도구 시도를 가리키며 생산자 참조를 대신하지 않습니다."
      : "toolResult.error is a stored diagnostic, not an error code or execution authority. For recover_artifact, set reworkTargetRef (preferred) or sourceIssueRef to the same-company/same-mission issue id or identifier owning the official product. recoveryTarget identifies the failed tool attempt, not the producer issue.",
    ko ? "산출물 등록: 이 언블록 이슈에는 등록할 수 없습니다. 적법한 생산자 컨텍스트로 이미 공식 등록된 산출물은 복구 검토에 사용할 수 있습니다."
      : "Artifact registration is forbidden on this unblock issue. Existing officially registered producer records can still be considered for recovery; this card does not delegate registration onto an arbitrary producer.",
    ko ? "같은 실행에서도 세대·재시도·반복 번호가 다르면 생산자 증거가 오래된 것입니다. prospective 항목은 재시도 승인으로 모든 단계 세대가 증가할 경우의 비교이며, 자동 보정이나 재시작 권한이 아닙니다."
      : "Same-run identity does not prove current producer evidence. prospective compares the generation bump on all steps if strict retry consumes authority; it neither repairs provenance nor authorizes restart.",
    ko ? "unavailable/unchecked는 확인되지 않았다는 뜻입니다. 조회 실패나 누락을 허용으로 해석하지 마세요. 지식 카드는 제목/ID 참고용이며 본문은 별도 조회하세요."
      : "unavailable/unchecked means not verified, never allowed. Knowledge titles/IDs are references only; fetch the full card separately.",
  ].join("\n");
}
