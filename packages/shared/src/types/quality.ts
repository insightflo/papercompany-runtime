// Core Quality Board API request/response types. Keep enum values aligned with QUALITY_* constants.

import type {
  QualityAnchorStatus,
  QualityEvidenceStatus,
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

export interface PromoteQualityAnchorRequest {
  verdictId: string;
  title: string;
}

export type PromoteQualityAnchorResponse = QualityEvaluatorAnchorCase;
