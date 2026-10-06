import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import { L } from "./companyLanguage";

type Labels = Record<string, { en: string; ko: string }>;
const priority: Labels = {
  critical: { en: "Critical", ko: "긴급" }, high: { en: "High", ko: "높음" },
  medium: { en: "Medium", ko: "보통" }, low: { en: "Low", ko: "낮음" },
};
const decisionStatus: Labels = {
  pending: { en: "Pending", ko: "대기 중" }, resolved: { en: "Resolved", ko: "완료" }, cancelled: { en: "Cancelled", ko: "취소됨" },
};
const approvalStatus: Labels = {
  pending: { en: "Pending", ko: "대기 중" }, approved: { en: "Approved", ko: "승인됨" },
  rejected: { en: "Rejected", ko: "거절됨" }, revision_requested: { en: "Revision requested", ko: "수정 요청됨" },
};
const continuationStatus: Labels = {
  pending: { en: "Pending", ko: "대기" }, dispatching: { en: "Dispatching", ko: "전달 중" },
  blocked: { en: "Blocked", ko: "막힘" }, exhausted: { en: "Exhausted", ko: "시도 소진" },
  queued: { en: "Queued", ko: "대기열 등록" }, deferred: { en: "Deferred", ko: "연기됨" },
  running: { en: "Running", ko: "실행 중" }, coalesced: { en: "Coalesced", ko: "통합됨" },
  completed: { en: "Completed", ko: "완료" }, skipped: { en: "Skipped", ko: "건너뜀" },
  failed: { en: "Failed", ko: "실패" }, cancelled: { en: "Cancelled", ko: "취소됨" },
  timed_out: { en: "Timed out", ko: "시간 초과" }, agent_unrunnable: { en: "Agent unrunnable", ko: "에이전트 실행 불가" },
  assignee_changed: { en: "Assignee changed", ko: "담당자 변경" }, issue_terminal: { en: "Issue terminal", ko: "이슈 종결" },
};
const ciConclusion: Labels = {
  success: { en: "Passed", ko: "통과" }, failure: { en: "Failed", ko: "실패" },
  cancelled: { en: "Cancelled", ko: "취소" }, timed_out: { en: "Timed out", ko: "시간 초과" },
  action_required: { en: "Action required", ko: "조치 필요" }, neutral: { en: "Neutral", ko: "중립" },
  skipped: { en: "Skipped", ko: "건너뜀" }, started: { en: "Started", ko: "시작됨" }, none: { en: "No result", ko: "결과 없음" },
};
const budgetScope: Labels = {
  company: { en: "Company", ko: "회사" }, agent: { en: "Agent", ko: "에이전트" }, project: { en: "Project", ko: "프로젝트" },
};
const missionDecisionStatus: Labels = {
  confirmed: { en: "Confirmed", ko: "확정" }, under_review: { en: "Under review", ko: "검토 중" }, retired: { en: "Retired", ko: "폐기" },
};
const categories = { priority, decisionStatus, approvalStatus, continuationStatus, ciConclusion, budgetScope, missionDecisionStatus };

/** Preserve unknown values and the raw value for audit tooltips. */
export function humanLabel(language: CompanyDefaultLanguage, category: keyof typeof categories, raw: string) {
  const labels = Object.hasOwn(categories[category], raw) ? categories[category][raw] : undefined;
  return { label: labels ? L(language, labels) : raw, raw };
}
