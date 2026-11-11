export interface HumanReviewEvidenceRef {
  label: string;
  href: string;
  location: string;
  description: string | null;
}

export interface HumanReviewImpact {
  ifApproved: string;
  ifRejected: string;
  ifWrong: string;
}

export interface HumanReviewPacket {
  schemaVersion: "human-review-v1";
  /** [사람 카드 축소 Stage 1] 증상 요약 — 최대 2줄(개행 ≤1, ≤220자). 구 패킷에는 없는 선택 필드다. */
  symptom?: string | null;
  decisionSubject: string;
  evidence: HumanReviewEvidenceRef[];
  interpretation: string;
  impact: HumanReviewImpact;
  unresolvedFacts: string[];
  questions: string[];
  recommendedNextStep: string;
  requiredReviewer: string;
}
