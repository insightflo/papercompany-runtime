// Core Quality Board API request/response types. Keep enum values aligned with QUALITY_* constants.

import type {
  QualityAnchorStatus,
  QualityDailyReportStatus,
  QualityEvidenceStatus,
  QualityEvaluatorRunStatus,
  QualityEvaluatorVersionStatus,
  QualityReviewItemStatus,
  QualityTargetType,
  QualityTriggerSource,
  QualityVerdict,
} from "../constants.js";

export interface QualityEvidenceRef {
  id: string;
  companyId: string;
  reviewItemId: string;
  surface: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  status: QualityEvidenceStatus;
  collectedByActorType: string | null;
  collectedByActorId: string | null;
  sourceRunId: string | null;
  sourceUrl: string | null;
  collectedAt: string;
  freshnessExpiresAt: string | null;
  blocking: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QualityReviewItemListItem {
  id: string;
  companyId: string;
  missionId: string | null;
  title: string;
  status: QualityReviewItemStatus;
  targetType: QualityTargetType;
  targetId: string | null;
  triggerSource: QualityTriggerSource;
  triggerMetadata: Record<string, unknown>;
  failureType: string | null;
  priority: string;
  createdAt: string;
  updatedAt: string;
  evidenceRefs: QualityEvidenceRef[];
  /** 소스 미션 요약(가능할 때). UI "현재 해결 여부" 표시용. */
  missionTitle?: string | null;
  missionStatus?: string | null;
}

export interface QualityVerdictRow {
  id: string;
  companyId: string;
  reviewItemId: string;
  missionId: string | null;
  targetType: string;
  targetId: string | null;
  verdict: QualityVerdict;
  failureType: string | null;
  reason: string | null;
  decidedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface QualityEvaluatorAnchorCase {
  id: string;
  companyId: string;
  sourceVerdictId: string;
  reviewItemId: string;
  missionId: string | null;
  title: string;
  failureType: string | null;
  verdict: QualityVerdict;
  evidenceRefs: Array<Record<string, unknown>>;
  status: QualityAnchorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface QualityEvaluatorVersion {
  id: string;
  companyId: string;
  name: string;
  evaluatorType: string;
  status: QualityEvaluatorVersionStatus;
  sourceAnchorCaseId: string | null;
  promptPatch: string | null;
  coverageSummary: Record<string, unknown>;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QualityEvaluatorCandidateRun {
  id: string;
  companyId: string;
  evaluatorVersionId: string;
  anchorCaseId: string | null;
  reviewItemId: string | null;
  status: QualityEvaluatorRunStatus;
  replayInput: Record<string, unknown>;
  replayResult: Record<string, unknown>;
  coverageSummary: Record<string, unknown>;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QualityDailyReport {
  id: string;
  companyId: string;
  reportDate: string;
  status: QualityDailyReportStatus;
  summary: Record<string, unknown>;
  sourceEvaluatorRunId: string | null;
  improvementIssueId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QualitySummary {
  openReviewItems: number;
  blockingEvidenceGaps: number;
  anchorCandidates: number;
  candidateEvaluators: number;
  dailyReports: number;
}

export interface CreateQualityReviewItemRequest {
  missionId?: string | null;
  title: string;
  targetType: QualityTargetType;
  targetId?: string | null;
  triggerSource: QualityTriggerSource;
  triggerMetadata?: Record<string, unknown>;
  failureType?: string | null;
  priority?: string;
  evidenceRefs?: Array<{
    surface: string;
    expected?: Record<string, unknown>;
    actual?: Record<string, unknown>;
    status?: QualityEvidenceStatus;
    sourceRunId?: string | null;
    sourceUrl?: string | null;
    freshnessExpiresAt?: string | null;
    blocking?: boolean;
  }>;
}

export interface CreateQualityReviewItemResponse {
  reviewItem: QualityReviewItemListItem;
  created: boolean;
}

export interface RecordQualityVerdictRequest {
  verdict: QualityVerdict;
  reason?: string;
  failureType?: string;
  requiredEvidenceSurfaces?: string[];
}

export interface RecordQualityVerdictResponse {
  verdict: QualityVerdictRow;
  reviewItem: QualityReviewItemListItem;
}

export interface RequestQualityEvidenceRequest {
  reason?: string;
  requiredEvidenceSurfaces: string[];
}

export interface RequestQualityEvidenceResponse {
  reviewItem: QualityReviewItemListItem;
}

export interface RecordQualityEvidenceRequest {
  surface: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  status: QualityEvidenceStatus;
  sourceRunId?: string | null;
  sourceUrl?: string | null;
  freshnessExpiresAt?: string | null;
  blocking?: boolean;
}

export interface RecordQualityEvidenceResponse {
  reviewItem: QualityReviewItemListItem;
}

export interface PromoteQualityAnchorRequest {
  verdictId: string;
  title: string;
}

export type PromoteQualityAnchorResponse = QualityEvaluatorAnchorCase;

export interface GenerateQualityDailyReportRequest {
  reportDate?: string;
}

export interface GenerateQualityDailyReportResponse {
  report: QualityDailyReport;
}
