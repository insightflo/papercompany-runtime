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
  decisionSubject: string;
  evidence: HumanReviewEvidenceRef[];
  interpretation: string;
  impact: HumanReviewImpact;
  unresolvedFacts: string[];
  questions: string[];
  recommendedNextStep: string;
  requiredReviewer: string;
}
