import { operatorDecisions } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import type { OperatorDecisionDefinition } from "@paperclipai/shared/types/operator-decision";
import type { QaRecoveryAdvice } from "./operator-decision-qa-recovery-advice.js";

type DecisionRow = typeof operatorDecisions.$inferSelect;
const collectionOption = "rerun_source_collection";
const producerOption = "extra_producer_rework";

function localized(locale: string, ko: string, en: string): string { return locale === "ko" ? ko : en; }

function findingsText(findings: readonly WorkflowVerdictFinding[], locale: string): string {
  return findings.map((finding) => `- [${finding.layer}] (${finding.id}) ${finding.summary}`).join("\n")
    || localized(locale, "- 현재 공식 QA 결함을 확인할 수 없습니다.", "- No current official QA findings are available.");
}

/** Creates a display copy only. The database row, option IDs, evidence links, and scopes stay intact. */
export function overlayQaRecoveryAdvice(card: Pick<DecisionRow, "title" | "description" | "definition">,
  advice: QaRecoveryAdvice, locale: string): Pick<DecisionRow, "title" | "description" | "definition"> {
  if (advice.disposition === "outside_default_scope") return card;
  const verified = advice.disposition === "verified", findings = verified ? advice.findings : [];
  const cause = verified ? advice.cause : null;
  const detail = verified
    ? `${localized(locale, "현재 공식 QA 원인", "Current official QA cause")}: ${cause === "artifact_only"
      ? localized(locale, "산출물(artifact) 결함", "produced artifact defects")
      : cause === "source_only" ? localized(locale, "원천 자료(source_data) 결함", "source data defects")
        : localized(locale, "원천 자료와 산출물 결함", "source data and produced artifact defects")}\n${findingsText(findings, locale)}`
    : localized(locale, "현재 공식 QA 결과와 저장된 카드의 전체 이력이 확인되지 않았습니다.",
      "The current official QA result could not be matched to this saved card's full history.");
  const retained = localized(locale, "완료된 생산 작업과 원본 결과는 유지됩니다.", "Completed producer work and its original result remain intact.");
  const direction = localized(locale, "선택은 사람의 방향 지시만 기록합니다. 재작업 한도 변경, 단계 초기화 또는 재시도는 하지 않으며 실제 조치에는 기존 native 권한이 필요합니다.",
    "A selection records human direction only. It does not change a rework limit, reset a step, or retry work; execution requires existing native permission.");
  const collection = verified && advice.collectionChoiceAllowed
    ? localized(locale, "원천 원인과 하나의 완료 upstream 대상이 확인되었습니다. 수집 방향은 기록할 수 있지만 실제 재실행은 기존 native 권한으로 다시 확인합니다.",
      "The source cause and one completed upstream target are verified. A collection direction may be recorded; existing native permission must still authorize execution.")
    : localized(locale, "저장된 수집 옵션은 과거 선택지로 남지만 현재 원인과 대상이 뒷받침하지 않아 제출할 수 없습니다.",
      "The saved collection option remains visible for history, but the current cause and target do not support submitting it.");
  const review = `${detail}\n\n${retained}\n${collection}\n${direction}`;
  const unknownFacts = [{ label: localized(locale, "현재 원인과 범위", "Current cause and scope"),
    value: localized(locale, "검증되지 않음; 기존 human review를 통해 확인해 주세요.", "Unverified; confirm through the existing human review."), status: "unknown" as const }];
  const facts = verified ? [
    { label: localized(locale, "반려 사유 범위", "Rejection cause"), value: detail, status: "known" as const },
    { label: localized(locale, "현재 재작업 회차", "Current rework iteration"), value: `${advice.iteration}/${advice.maxIterations} — ${direction}`, status: "known" as const },
    ...findings.map((finding) => ({ label: localized(locale, `결함 ${finding.id}`, `Finding ${finding.id}`),
      value: `[${finding.layer}] ${finding.summary}`, status: "known" as const })),
  ] : unknownFacts;
  const options = card.definition.options.map((option) => {
    const typedOption: OperatorDecisionDefinition["options"][number] = option;
    const { recommended: _recommended, recommendationReason: _reason, ...neutral } = typedOption;
    return { ...neutral, facts, ...(typedOption.id === collectionOption ? { description: collection }
      : typedOption.id === producerOption ? { description: direction } : {}) };
  });
  const humanReview = card.definition.humanReview ? {
    ...card.definition.humanReview,
    evidence: card.definition.humanReview.evidence.map((item) => ({ ...item, description: detail })),
    interpretation: review,
    impact: { ...card.definition.humanReview.impact, ifApproved: direction, ifWrong: collection },
    unresolvedFacts: verified ? card.definition.humanReview.unresolvedFacts : unknownFacts.map((fact) => fact.value),
    questions: [localized(locale, "현재 QA 원인과 남은 범위 안에서 어떤 사람의 방향을 선택할까요?",
      "Which human direction fits the current QA cause and remaining bounded scope?")],
    recommendedNextStep: localized(locale, "공식 QA 원인과 카드 연결을 확인한 뒤 native 권한 범위에서 방향을 선택해 주세요.",
      "Confirm the official QA cause and card binding, then choose a direction within native permission."),
  } : undefined;
  const definition: OperatorDecisionDefinition = { ...card.definition, options,
    ...(humanReview ? { humanReview } : {}) };
  const causeLabel = cause === "artifact_only" ? localized(locale, "산출물", "artifact")
    : cause === "source_only" ? localized(locale, "원천 자료", "source data") : localized(locale, "혼합 원인", "mixed causes");
  const title = verified ? localized(locale, `QA 결함 — ${causeLabel} 처리 방향 선택`, `QA findings — choose a direction for ${causeLabel}`)
    : localized(locale, "과거 QA 카드 — 현재 원인 미확인", "Historical QA card — current cause unverified");
  return { title, description: `${review}\n\n${findingsText(findings, locale)}`, definition };
}

