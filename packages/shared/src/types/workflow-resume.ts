/**
 * [purpose] 미션 워크플로 재개(workflow resume) UI·서버 공용 뷰 계약.
 * 2026-09-07 승인 플랜(plan 문서 29-89행)과 동일하게 유지한다. 임의 확장 금지.
 */

export type ResumeBlocker = {
  code: string;
  stepId?: string;
  message: string;
};

/** [review-relief v1] 완화된 보수 검토 차단의 경고 표시. 서버는 완화가 동작할 때만 채운다. */
export type ResumeWarning = {
  code: string;
  stepId?: string;
  message: string;
};

/** 완화 기반 — human_approval(사람 결정 해소+continuation accepted) 또는 stuck(#720 판정). */
export type ResumeReliefBasis = "human_approval" | "stuck";

export type ResumeRelief = {
  active: boolean;
  bases: ResumeReliefBasis[];
};

export type ResumePreview = {
  schemaVersion: 1;
  companyId: string;
  missionId: string;
  workflowRunId: string;
  startStepId: string;
  eligible: boolean;
  blockers: ResumeBlocker[];
  /** [review-relief v1] 완화로 차단에서 경고로 내려간 항목. 기존 응답은 생략된다. */
  warnings?: ResumeWarning[];
  /** [review-relief v1] 완화 상태·기반. 기존 응답은 생략된다. */
  relief?: ResumeRelief;
  affected: Array<{ stepId: string; name: string; action: "execute" | "reevaluate" }>;
  preserved: Array<{ stepId: string; name: string }>;
  evidence: Array<{ id: string; sha256: string }>;
  generation: "none" | "possible";
  budget: "verified" | "unknown";
  approvals: Array<{ stepId: string; required: true }>;
  snapshotToken: string | null;
  expiresAt: string | null;
};

export type ResumeRequestView = {
  id: string;
  workflowRunId: string;
  startStepId: string;
  state: "pending_delivery" | "accepted" | "blocked" | "cancelled";
  acceptanceId: string | null;
  code: string | null;
  createdAt: string;
};
