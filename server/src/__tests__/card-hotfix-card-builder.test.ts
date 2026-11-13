// [카드 UX 핫픽스 2026-11-13] 실제 카드 7cf2aaf7 회귀 방지 —
//   ① 쉬운 해석이 비지 않음(파생 실패 시 최소 폴백 문장)
//   ② 증상은 항상 한국어 완결 최대 2줄(영어 원문은 근거 링크로 이동)
//   ③ 읽기 투영 권고가 해석·다음 단계를 바꾸지 않음 — 경고는 전제 안내로만.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMissionOwnerHumanInputDecisionCard,
  HUMAN_INPUT_INTERPRETATION_FALLBACK,
  isForeignDominantLine,
  SYMPTOM_EVIDENCE_POINTER,
  SYMPTOM_STATUS_FALLBACK,
  type MissionOwnerHumanInputCardSpec,
} from "../services/missions/mission-owner-human-input-card.js";
import { overlayRecoveryAdvice } from "../services/operator-decision-recovery-advice.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";

function spec(overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec {
  return {
    companyId: randomUUID(),
    missionId: randomUUID(),
    decisionEventId: randomUUID(),
    decision: "escalate",
    ownerActionIssueId: randomUUID(),
    ownerActionIssueStatus: "in_progress",
    requestedByAgentId: randomUUID(),
    reason: "사람 승인이 필요합니다",
    nextAction: "운영자 승인 후 다음 단계를 진행해 주세요",
    evidence: null,
    issueTitle: "Owner oversight",
    issueIdentifier: "RES-11217",
    sourceIssueId: null,
    workflowRunId: randomUUID(),
    ...overrides,
  };
}

const ENGLISH_REASON = "Auto-recovery has been stuck for over 12 hours. Operator decision is required to move forward.";
const ENGLISH_NEXT_ACTION = "Approve restart_from_start (or replan) so today's concept-radar completes through official QA/publish/verify gates";

describe("card hotfix — 증상 한국어 완결 2줄", () => {
  it("영어 사유는 원문을 잘라 보여주지 않고 한국어 상태+근거 안내 2줄로 대체한다", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: ENGLISH_REASON }));
    const symptom = card.definition.humanReview!.symptom!;
    const lines = symptom.split("\n");
    expect(lines).toEqual([SYMPTOM_STATUS_FALLBACK, SYMPTOM_EVIDENCE_POINTER]);
    expect(lines).toHaveLength(2);
    // 영어 원문의 어느 조각도 증상에 남지 않는다 — 원문은 근거 링크(오너 이슈)에서 확인한다.
    expect(symptom).not.toMatch(/[A-Za-z]/);
    expect(symptom).not.toContain("Auto-recovery");
    expect(symptom).not.toContain("…");
    expect(card.definition.humanReview!.evidence[0]!.href).toContain("/issues/");
  });

  it("영어 권고문이 reason 에 섞여 있어도 증상은 한국어 완결을 유지한다", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: `${ENGLISH_NEXT_ACTION}\n${ENGLISH_REASON}` }));
    const symptom = card.definition.humanReview!.symptom!;
    expect(symptom.split("\n")).toHaveLength(2);
    expect(symptom).not.toMatch(/[A-Za-z]/);
    expect(symptom).toContain(SYMPTOM_EVIDENCE_POINTER);
  });

  it("한국어 줄 + 영어 줄 혼합이면 한국어 줄을 살리고 영어 줄 자리에 근거 안내를 둔다", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: `자동 복구가 멈췄습니다\n${ENGLISH_REASON}` }));
    const lines = card.definition.humanReview!.symptom!.split("\n");
    expect(lines).toEqual(["자동 복구가 멈췄습니다", SYMPTOM_EVIDENCE_POINTER]);
  });

  it("한국어 사유는 기존처럼 그대로 표시한다(회귀 없음)", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: "자동 복구가 12시간 멈췄습니다" }));
    expect(card.definition.humanReview!.symptom).toBe("자동 복구가 12시간 멈췄습니다");
  });

  it("한국어 문장에 영어 고유명사가 섞여 있어도(한국어 우세) 잘라버리지 않는다", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: "미션이 concept-radar 수집을 기다립니다" }));
    expect(card.definition.humanReview!.symptom).toBe("미션이 concept-radar 수집을 기다립니다");
  });

  it("220자 초과 한국어 사유는 문장 경계에서만 잘린다", () => {
    const long = `자동 복구가 멈췄습니다. ${"운영자 확인이 필요합니다. ".repeat(30)}`;
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ reason: long }));
    const symptom = card.definition.humanReview!.symptom!;
    expect(symptom.length).toBeLessThanOrEqual(220);
    expect(/[.!?]$/.test(symptom)).toBe(true);
  });
});

describe("card hotfix — 쉬운 해석 비면 금지", () => {
  it("모든 카드는 비어 있지 않은 한국어 해석 문장을 가진다", () => {
    for (const overrides of [
      {},
      { reason: ENGLISH_REASON, nextAction: ENGLISH_NEXT_ACTION },
      { workflowRunId: null },
      { decision: "request_input" as const },
    ]) {
      const card = buildMissionOwnerHumanInputDecisionCard(spec(overrides));
      const interpretation = card.definition.humanReview!.interpretation;
      expect(interpretation.length).toBeGreaterThan(0);
      expect(interpretation).not.toContain("\n");
      expect(interpretation.length).toBeLessThanOrEqual(200);
    }
  });

  it("해석 파생이 빈 결과를 내면 최소 폴백 문장으로 채운다", () => {
    expect(HUMAN_INPUT_INTERPRETATION_FALLBACK.length).toBeGreaterThan(0);
    expect(HUMAN_INPUT_INTERPRETATION_FALLBACK).toContain("선택지");
  });
});

describe("card hotfix — 권고 오버레이가 해석 문장을 삼키지 않는다", () => {
  // [카드 표시 결함 2026-11-13] 계약 갱신 — 검증·정책 한정문은 해석·다음 단계에 섞지 않고
  //   전제 안내(unresolvedFacts → #717 prerequisite notice)로만 표시한다(RES-11302 실화).
  it("읽기 투영은 해석·다음 단계를 원문 그대로 두고 경고는 전제 안내에만 둔다", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec());
    const projected = overlayRecoveryAdvice(card.definition, {
      disposition: "unproven_restart_hold",
      reason: "stored_input_or_hash_unproven",
    });
    // 해석·다음 단계는 요청자 원문 그대로 — 라벨·경고 문구가 섞이지 않는다.
    expect(projected.humanReview!.interpretation).toBe(card.definition.humanReview!.interpretation);
    expect(projected.humanReview!.interpretation).not.toContain("요청자가 제공한 설명");
    expect(projected.humanReview!.recommendedNextStep).toBe(card.definition.humanReview!.recommendedNextStep);
    expect(projected.humanReview!.recommendedNextStep).not.toContain("요청자가 제시한 다음 단계");
    // 경고 문구는 전제 안내 말미에만 보존된다.
    expect(projected.humanReview!.unresolvedFacts.at(-1)).toContain("입증하지 않습니다");
    // 표시 사본의 '결정 사유'는 선택 입력으로 완화(저장 정의는 required 유지).
    expect(projected.comment.mode).toBe("optional");
    expect(card.definition.comment.mode).toBe("required");
    // 재시작 옵션의 추천 표시는 여전히 제거된다.
    expect(projected.options.find((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID))
      .not.toHaveProperty("recommended");
  });
});

describe("card hotfix — isForeignDominantLine 판정", () => {
  it("영어 문장은 외국어 위주로 판정한다", () => {
    expect(isForeignDominantLine("Approve restart_from_start (or replan)")).toBe(true);
    expect(isForeignDominantLine("미션")).toBe(false);
    expect(isForeignDominantLine("미션이 concept-radar 수집을 기다립니다")).toBe(false);
    expect(isForeignDominantLine("한 english")).toBe(true);
    expect(isForeignDominantLine("라틴만 latin")).toBe(false);
  });
});
