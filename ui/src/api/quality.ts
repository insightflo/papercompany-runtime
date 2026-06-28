// [파일 목적] Core Quality Board API client. company-scoped 품질 검수 큐 + 성장 루프.
// [외부 연결] server routes/quality.ts 와 1:1. ui pages/Quality.tsx 가 소비.
import type {
  CreateQualityReviewItemRequest,
  CreateQualityReviewItemResponse,
  GenerateQualityDailyReportResponse,
  PromoteQualityAnchorResponse,
  QualityDailyReport,
  QualityEvaluatorAnchorCase,
  QualityEvaluatorCandidateRun,
  QualityEvaluatorVersion,
  QualityReviewItemListItem,
  QualitySummary,
  RecordQualityEvidenceRequest,
  RecordQualityEvidenceResponse,
  RecordQualityVerdictRequest,
  RecordQualityVerdictResponse,
  RequestQualityEvidenceRequest,
  RequestQualityEvidenceResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const qualityApi = {
  summary: (companyId: string) =>
    api.get<QualitySummary>(`/companies/${companyId}/quality/summary`),
  listReviewItems: (companyId: string) =>
    api.get<QualityReviewItemListItem[]>(`/companies/${companyId}/quality/review-items`),
  getReviewItem: (reviewItemId: string) =>
    api.get<QualityReviewItemListItem>(`/quality/review-items/${reviewItemId}`),
  createReviewItem: (companyId: string, body: CreateQualityReviewItemRequest) =>
    api.post<CreateQualityReviewItemResponse>(`/companies/${companyId}/quality/review-items`, body),
  recordVerdict: (reviewItemId: string, body: RecordQualityVerdictRequest) =>
    api.post<RecordQualityVerdictResponse>(`/quality/review-items/${reviewItemId}/verdict`, body),
  requestEvidence: (reviewItemId: string, body: RequestQualityEvidenceRequest) =>
    api.post<RequestQualityEvidenceResponse>(`/quality/review-items/${reviewItemId}/request-evidence`, body),
  recordEvidence: (reviewItemId: string, body: RecordQualityEvidenceRequest) =>
    api.post<RecordQualityEvidenceResponse>(`/quality/review-items/${reviewItemId}/evidence`, body),
  promoteAnchor: (reviewItemId: string, verdictId: string, title: string) =>
    api.post<PromoteQualityAnchorResponse>(`/quality/review-items/${reviewItemId}/promote-anchor`, { verdictId, title }),
  listAnchors: (companyId: string) =>
    api.get<QualityEvaluatorAnchorCase[]>(`/companies/${companyId}/quality/anchors`),
  listEvaluatorVersions: (companyId: string) =>
    api.get<QualityEvaluatorVersion[]>(`/companies/${companyId}/quality/evaluator-versions`),
  listCandidateRuns: (companyId: string, versionId?: string) =>
    api.get<QualityEvaluatorCandidateRun[]>(
      `/companies/${companyId}/quality/candidate-runs${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`,
    ),
  replayCandidateRun: (companyId: string, runId: string, body: { regressions?: number; resultSummary?: string }) =>
    api.post<QualityEvaluatorCandidateRun>(`/companies/${companyId}/quality/candidate-runs/${runId}/replay`, body),
  promoteEvaluatorVersion: (companyId: string, versionId: string) =>
    api.post<QualityEvaluatorVersion>(`/companies/${companyId}/quality/evaluator-versions/${versionId}/promote`, {}),
  generateDailyReport: (companyId: string, body: { reportDate?: string } = {}) =>
    api.post<GenerateQualityDailyReportResponse>(`/companies/${companyId}/quality/daily-reports/generate`, body),
  listDailyReports: (companyId: string) =>
    api.get<QualityDailyReport[]>(`/companies/${companyId}/quality/daily-reports`),
};
