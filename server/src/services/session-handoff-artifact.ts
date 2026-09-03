/**
 * [세션 핸드오프 아티팩트 — v1 + 결정원장 포인터(A안 2026-09-05)]
 * 구조 필드는 자유서술 요약(lastRunSummaryText)을 대체하는 것이 아니라, 권위 있는
 * 상태를 '포인터+판번호'로 가리킨다(AstronOS: 요약 전략 0/15 vs 지위+판번호 14/15).
 * 규칙 8: 이 아티팩트는 다음 세션의 맥락 전달용 표시물일 뿐, 실행 통제의 권위가
 * 아니다. 결정의 진실원은 mission_rolling_state 구조 레코드다.
 */
export interface SessionHandoffDecisionLogPointer {
  missionId: string;
  revision: number;
}

export interface SessionHandoffArtifact {
  version: 1;
  previousSessionId: string;
  previousRunId: string | null;
  issueId: string | null;
  rotationReason: string;
  lastRunSummaryText: string | null;
  missionDecisionLogPointer?: SessionHandoffDecisionLogPointer | null;
}

export function buildSessionHandoffArtifact(input: {
  previousSessionId: string;
  previousRunId: string | null;
  issueId: string | null;
  rotationReason: string;
  lastRunSummaryText: string | null;
  missionDecisionLogPointer?: SessionHandoffDecisionLogPointer | null;
}): SessionHandoffArtifact {
  const artifact: SessionHandoffArtifact = {
    version: 1,
    previousSessionId: input.previousSessionId,
    previousRunId: input.previousRunId,
    issueId: input.issueId,
    rotationReason: input.rotationReason,
    lastRunSummaryText: input.lastRunSummaryText,
  };
  if (input.missionDecisionLogPointer !== undefined) {
    artifact.missionDecisionLogPointer = input.missionDecisionLogPointer;
  }
  return artifact;
}
