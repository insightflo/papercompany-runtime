import type { ActivityEvent, CompanyDefaultLanguage } from "@paperclipai/shared";
import { timeAgo } from "../lib/timeAgo";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";

const actionLabels: Record<string, { en: string; ko: string }> = {
  "operator_decision.created": { en: "Interactive Card created", ko: "결정 카드 생성됨" },
  "operator_decision.resolved": { en: "Interactive Card resolved", ko: "결정 완료" },
  "operator_decision.cancelled": { en: "Interactive Card cancelled", ko: "결정 카드 취소됨" },
  "operator_decision.continuation_accepted": { en: "Continuation queued", ko: "이어서 진행 예약됨" },
  "operator_decision.continuation_blocked": { en: "Continuation blocked", ko: "이어서 진행 보류됨" },
  "operator_decision.continuation_exhausted": { en: "Continuation exhausted", ko: "이어서 진행 시도 소진됨" },
  "operator_decision.continuation_retried": { en: "Continuation retried", ko: "이어서 진행 재시도됨" },
  "operator_decision.outcome_reported": { en: "Requester outcome reported", ko: "요청자 결과 회신됨" },
};

// [4b-2 라벨 체계] 카드 왕복 단계 한국어 라벨(2026-10-15 승인 문구). 진행 단계는 이 매핑이,
// 종결 상태(completed/skipped/issue_terminal 등)는 기존 continuationStatus 의미를 그대로 유지한다.
const stageLabels: Record<string, { en: string; ko: string }> = {
  pending: { en: "Awaiting selection", ko: "선택 대기" },
  dispatching: { en: "Delivering selection", ko: "선택 전달 중" },
  queued: { en: "Waiting for requester delivery", ko: "요청자 전달 대기" },
  deferred: { en: "Waiting for requester delivery", ko: "요청자 전달 대기" },
  running: { en: "In progress", ko: "진행 중" },
  blocked: { en: "Delivery failed · action needed", ko: "전달 실패 · 조치 필요" },
  exhausted: { en: "Delivery failed · action needed", ko: "전달 실패 · 조치 필요" },
};
const requesterOutcomeLabels: Record<string, { en: string; ko: string }> = {
  acknowledged: { en: "Requester acknowledged", ko: "요청자 확인" },
  in_progress: { en: "In progress", ko: "진행 중" },
  completed: { en: "Completed", ko: "처리 완료" },
  failed: { en: "Requester run failed", ko: "요청자 실행 실패" },
  not_applied: { en: "Selection not applied (situation changed)", ko: "선택 미적용(상황 변경)" },
};

/** 카드 왕복 진행 단계 라벨 — 종결 상태는 기존 continuationStatus 라벨로 대체(의미 유지). */
export function operatorDecisionStageLabel(language: CompanyDefaultLanguage, effectiveStatus: string): string {
  const stage = Object.hasOwn(stageLabels, effectiveStatus) ? stageLabels[effectiveStatus] : undefined;
  return stage ? L(language, stage) : humanLabel(language, "continuationStatus", effectiveStatus).label;
}

/** 요청자 회신 outcome 라벨 — 알 수 없는 값은 원문 보존(humanLabel 규칙 동일). */
export function requesterOutcomeStatusLabel(language: CompanyDefaultLanguage, status: string): string {
  const label = Object.hasOwn(requesterOutcomeLabels, status) ? requesterOutcomeLabels[status] : undefined;
  return label ? L(language, label) : status;
}

/** 취소 사유 라벨 — target_changed 만 승인 문구, 그 외 사유는 원문 그대로 부가 표시. */
export function cancellationReasonLabel(language: CompanyDefaultLanguage, reason: string): string {
  return reason === "target_changed"
    ? L(language, { en: "Situation changed · selection not applied", ko: "상황 변경됨 · 선택 미적용" })
    : reason;
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function number(value: unknown) { return typeof value === "number" ? value : null; }
function list(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
function Raw({ value }: { value: unknown }) {
  return <span className="font-mono" title={text(value)}>{text(value)}</span>;
}
function EventDetails({ event }: { event: ActivityEvent }) {
  const lang = useCompanyLanguage();
  const details = event.details ?? {};
  const continuation = (value: unknown) => <span title={text(value)}>{operatorDecisionStageLabel(lang, text(value))}</span>;
  if (event.action === "operator_decision.created") {
    const interactions: Record<string, { en: string; ko: string }> = {
      single_select: { en: "Single choice", ko: "단일 선택" }, multi_select: { en: "Multi choice", ko: "다중 선택" }, action: { en: "Immediate action", ko: "즉시 조치" },
    };
    const interaction = interactions[text(details.interactionType)];
    return <p>{L(lang, { en: "Priority", ko: "우선순위" })} <span title={text(details.priority)}>{humanLabel(lang, "priority", text(details.priority)).label}</span> · <span title={text(details.interactionType)}>{interaction ? L(lang, interaction) : text(details.interactionType)}</span> · <Raw value={details.sourceType} /></p>;
  }
  if (event.action === "operator_decision.resolved") {
    const selected = list(details.selectedOptionIds);
    return <p>{L(lang, { en: "Action", ko: "조치" })} <Raw value={details.actionId} /> · {L(lang, { en: "outcome", ko: "결과" })} <Raw value={details.outcome} /> · {L(lang, { en: "selected", ko: "선택" })} <Raw value={selected.length ? selected.join(", ") : L(lang, { en: "none", ko: "없음" })} /> · {details.commentPresent === true ? L(lang, { en: "Comment provided", ko: "메모 있음" }) : L(lang, { en: "No comment", ko: "메모 없음" })}</p>;
  }
  if (event.action === "operator_decision.cancelled") {
    const reason = text(details.reason);
    return <p>{L(lang, { en: "Cancelled by", ko: "취소:" })} <Raw value={details.cancelledByActorType} /> <Raw value={details.cancelledByActorId} />{reason ? <> · <span title={reason}>{cancellationReasonLabel(lang, reason)}</span></> : null}</p>;
  }
  if (event.action === "operator_decision.outcome_reported") {
    const reason = text(details.reason);
    return <p>{L(lang, { en: "outcome", ko: "결과" })} <span title={text(details.status)}>{requesterOutcomeStatusLabel(lang, text(details.status))}</span>{reason ? <> · <Raw value={reason} /></> : null}</p>;
  }
  if (event.action === "operator_decision.continuation_retried") {
    return <p>{L(lang, { en: "Generation", ko: "재시도 회차" })} {number(details.previousGeneration)} → {number(details.newGeneration)} · {L(lang, { en: "previous", ko: "이전 상태" })} {continuation(details.previousEffectiveStatus)}</p>;
  }
  if (event.action.startsWith("operator_decision.continuation_")) {
    return <p>{continuation(details.effectiveStatus)}{details.errorCode ? <> · <Raw value={details.errorCode} /></> : null} · {L(lang, { en: `Generation ${number(details.generation)}`, ko: `재시도 회차 ${number(details.generation)}` })} · {L(lang, { en: `attempt ${number(details.attempt)}`, ko: `시도 ${number(details.attempt)}회` })}</p>;
  }
  return null;
}
export function OperatorDecisionActivity({ event }: { event: ActivityEvent }) {
  const lang = useCompanyLanguage();
  return <article className="px-4 py-3 text-sm"><div className="flex items-start justify-between gap-3"><div>
    <h3 className="font-medium">{L(lang, actionLabels[event.action] ?? { en: "Interactive Card event", ko: "결정 카드 기록" })}</h3>
    <div className="mt-1 text-xs text-muted-foreground"><EventDetails event={event} /></div>
  </div><span className="shrink-0 text-xs text-muted-foreground">{timeAgo(event.createdAt)}</span></div></article>;
}
