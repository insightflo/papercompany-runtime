import type {
  PromoteQualityAnchorRequest,
  PromoteQualityAnchorResponse,
  QualityReviewItemListItem,
  RecordQualityVerdictRequest,
  RecordQualityVerdictResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const qualityApi = {
  listReviewItems: (companyId: string) =>
    api.get<QualityReviewItemListItem[]>(`/companies/${companyId}/quality/review-items`),
  recordVerdict: (reviewItemId: string, body: RecordQualityVerdictRequest) =>
    api.post<RecordQualityVerdictResponse>(`/quality/review-items/${reviewItemId}/verdict`, body),
  promoteAnchor: (reviewItemId: string, body: PromoteQualityAnchorRequest) =>
    api.post<PromoteQualityAnchorResponse>(`/quality/review-items/${reviewItemId}/promote-anchor`, body),
};
