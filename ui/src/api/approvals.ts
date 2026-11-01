import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

/** [휴먼카드 해석] 표시 전용 해석 스냅숋 — 서버 card_human_summaries 뷰. */
export interface HumanSummaryView {
  status: "pending" | "done" | "failed" | string;
  adapterType: string;
  model: string;
  summary: {
    oneLine: string;
    whatHappening: string;
    decisionNeeded: string;
    options: Array<{ label: string; meaning: string }>;
    cautions: string[];
  } | null;
  error: string | null;
  updatedAt: string;
}

export type ApprovalWithSummary = Approval & { humanSummary?: HumanSummaryView | null };

type ApprovalTarget = string | Pick<Approval, "id" | "companyId" | "type">;
function actionPath(target: ApprovalTarget, action: string) {
  return typeof target !== "string" && target.type === "workflow_replacement"
    ? `/companies/${target.companyId}/workflow-replacements/${target.id}/${action}`
    : `/approvals/${typeof target === "string" ? target : target.id}/${action}`;
}
export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (target: ApprovalTarget, decisionNote?: string) =>
    api.post<Approval>(actionPath(target, "approve"), { decisionNote }),
  reject: (target: ApprovalTarget, decisionNote?: string) =>
    api.post<Approval>(actionPath(target, "reject"), { decisionNote }),
  requestRevision: (target: ApprovalTarget, decisionNote?: string) =>
    api.post<Approval>(actionPath(target, "request-revision"), { decisionNote }),
  resubmit: (target: ApprovalTarget, payload?: Record<string, unknown>) =>
    api.post<Approval>(actionPath(target, "resubmit"), typeof target !== "string" && target.type === "workflow_replacement" ? payload ?? {} : { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  retranslateSummary: (id: string, body: { adapterType?: string; model?: string }) =>
    api.post<{ id: string; humanSummary: HumanSummaryView | null }>(`/approvals/${id}/summary/retranslate`, body),
};
