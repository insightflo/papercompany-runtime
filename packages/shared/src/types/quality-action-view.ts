import type { QualityEffect, QualityTarget } from "../validators/quality-automation.js";

/**
 * Quality 조치 카드 표시 투영(조회 전용). 표시 상태는 권위 기록에서 투영한 값이며
 * 실행·완료·재시도 판단의 원천이 아니다(설계 §11.3). T11 화면 작업이 이 표현을 소비한다.
 */
export type QualityActionDisplayState =
  | "pending_decision"
  | "auto_processing"
  | "verifying"
  | "applied"
  | "applied_awaiting_use"
  | "held"
  | "rejected"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "withdrawn";

export type QualityActionView = {
  id: string;
  companyId: string;
  groupId: string;
  parentActionId: string | null;
  kind: "current_output" | "qa_addendum";
  state: string;
  revision: number;
  policyVersionId: string;
  target: QualityTarget;
  effect: QualityEffect;
  intentKey: string;
  createdAt: string;
  updatedAt: string;
  cancelRequestedAt: string | null;
  /** 서버가 권위 기록에서 계산한 사람용 표시 상태. 실행 권위로 사용 금지. */
  displayState: QualityActionDisplayState | null;
  displayLabel: string | null;
};
