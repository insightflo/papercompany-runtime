/**
 * [purpose] 미션 워크플로 재개(workflow resume) UI·서버 공용 뷰 계약.
 * 2026-09-07 승인 플랜(plan 문서 29-89행)과 동일하게 유지한다. 임의 확장 금지.
 */

export type ResumeBlocker = {
  code: string;
  stepId?: string;
  message: string;
};

export type ResumePreview = {
  schemaVersion: 1;
  companyId: string;
  missionId: string;
  workflowRunId: string;
  startStepId: string;
  eligible: boolean;
  blockers: ResumeBlocker[];
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
