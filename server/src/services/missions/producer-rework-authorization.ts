// server/src/services/missions/producer-rework-authorization.ts
//
// producer rework 승인 게이트(req 3). supervision 이 QA 실패로 producer 를 재오픈하기 전에
// (a) owner 의 명시 reworkTarget, (b) current generation 의 공식 REQUEST_CHANGES verdict 중
// 하나에 근거하는지 검사. DAG 역참조 추측만으로 producer 를 재작업시키는 것을 차단(RES-1315/1318).
// 우선순위(codex 보완): explicit target → fresh current-gen REQUEST_CHANGES → guardrail.
//   fresh 공식 RC 는 guardrail error 보다 우선 — 공식 RC 가 producer rework 필요 신호.
// pure 함수 — DB 미의존. supervision.ts case "retry_source_issue" 에서 호출.

export type ProducerReworkVerdictEntry = {
  verdict?: string | null;
  observedAt: Date | null;
};

export type ProducerReworkAuthorizationReason =
  | "explicit_rework_target"
  | "fresh_request_changes_verdict"
  | "step_input_manifest_guardrail"
  | "current_generation_unverified"
  | "stale_or_absent_verdict"
  | "dag_guess_without_verdict";

export type ProducerReworkAuthorization =
  | { authorized: true; reason: "explicit_rework_target"; reworkTargetRef: string }
  | { authorized: true; reason: "fresh_request_changes_verdict"; qaIssueId: string; observedAt: Date }
  | { authorized: false; reason: "step_input_manifest_guardrail" }
  | { authorized: false; reason: "current_generation_unverified" }
  | { authorized: false; reason: "stale_or_absent_verdict" }
  | { authorized: false; reason: "dag_guess_without_verdict" };

export const STEP_INPUT_MANIFEST_GUARDRAIL_REASON_CODE = "STEP_INPUT_MANIFEST_GUARDRAIL";
export const REQUEST_CHANGES_VERDICT = "request_changes";

export interface ProducerReworkAuthInput {
  ownerReworkRef?: string | null;
  failureReasonCode?: string | null;
  qaIssueId?: string | null;
  validationVerdictsByIssueId?: ReadonlyMap<string, ProducerReworkVerdictEntry | undefined>;
  /** producer 현재 반복 완료 시각(current generation proof). 없으면 request_changes 로 reopen 불가. */
  producerCompletedAt?: Date | null;
}

function isFreshRequestChangesVerdict(input: ProducerReworkAuthInput): { qaIssueId: string; observedAt: Date } | null {
  if (!input.qaIssueId || !input.validationVerdictsByIssueId || !input.producerCompletedAt) return null;
  const entry = input.validationVerdictsByIssueId.get(input.qaIssueId);
  if (!entry || !entry.observedAt || entry.verdict !== REQUEST_CHANGES_VERDICT) return null;
  // observedAt >= producerCompletedAt (stale-verdict-guard.ts 역). 미만이면 이전 세대 verdict.
  if (entry.observedAt.getTime() < input.producerCompletedAt.getTime()) return null;
  return { qaIssueId: input.qaIssueId, observedAt: entry.observedAt };
}

// 분기 순서(codex 보완 3): (1) explicit target → (2) fresh current-gen REQUEST_CHANGES(guardrail 무관)
//   → (3) guardrail(fresh RC 없을 때만, QA 자체 recovery) → (4) verdict 있으나 generation 미확정
//   → (5) stale → (6) DAG 추측/부재.
export function authorizeProducerRework(input: ProducerReworkAuthInput): ProducerReworkAuthorization {
  // (1) owner 명시 reworkTarget — 항상 최우선(owner 판단 책임).
  const ref = input.ownerReworkRef?.trim();
  if (ref && ref.length > 0) {
    return { authorized: true, reason: "explicit_rework_target", reworkTargetRef: ref };
  }
  // (2) current-gen 공식 REQUEST_CHANGES — guardrail error 보다 우선(공식 RC = producer rework 필요).
  const fresh = isFreshRequestChangesVerdict(input);
  if (fresh) {
    return { authorized: true, reason: "fresh_request_changes_verdict", qaIssueId: fresh.qaIssueId, observedAt: fresh.observedAt };
  }
  // (3) guardrail(self-policy 위반) — fresh RC 없을 때만 producer 결함 아님 → QA 자체 재시도/재할당.
  if (input.failureReasonCode && input.failureReasonCode.toUpperCase() === STEP_INPUT_MANIFEST_GUARDRAIL_REASON_CODE) {
    return { authorized: false, reason: "step_input_manifest_guardrail" };
  }
  const entry = input.qaIssueId && input.validationVerdictsByIssueId
    ? input.validationVerdictsByIssueId.get(input.qaIssueId)
    : undefined;
  // (4) request_changes verdict 가 있으나 producerCompletedAt(current generation proof) 부재 → 거부.
  if (entry?.verdict === REQUEST_CHANGES_VERDICT && entry.observedAt && !input.producerCompletedAt) {
    return { authorized: false, reason: "current_generation_unverified" };
  }
  // (5) request_changes verdict 가 stale(이전 세대) → 거부(rework cap 이중 소진 방지).
  if (entry?.verdict === REQUEST_CHANGES_VERDICT && entry.observedAt && input.producerCompletedAt
    && entry.observedAt.getTime() < input.producerCompletedAt.getTime()) {
    return { authorized: false, reason: "stale_or_absent_verdict" };
  }
  // (6) 그 외(DAG 역참조 추측, verdict 부재/pass) → 거부. RES-1315 핵심 차단점.
  return { authorized: false, reason: "dag_guess_without_verdict" };
}
