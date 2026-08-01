import type {
  CreateOperatorDecisionInput,
  OperatorDecisionContinuationView,
  OperatorDecisionView,
} from "@paperclipai/shared/types/operator-decision";
import { api } from "./client";

export type OperatorDecisionViewName = "pending" | "attention" | "history";
export interface ResolveOperatorDecisionInput {
  actionId: string;
  selectedOptionIds: string[];
  comment: string | null;
}
export interface OperatorDecisionResolutionResponse {
  decision: OperatorDecisionView;
  applied: boolean;
  continuation: OperatorDecisionContinuationView | null;
}
export interface OperatorDecisionListResponse {
  data: OperatorDecisionView[];
  page: { nextCursor: string | null };
}

export const operatorDecisionsApi = {
  list: (companyId: string, view: OperatorDecisionViewName, limit = 50) =>
    api.get<OperatorDecisionListResponse>(
      `/companies/${companyId}/operator-decisions?view=${view}&limit=${limit}`,
    ),
  create: (companyId: string, input: CreateOperatorDecisionInput) =>
    api.post<{ data: OperatorDecisionView; replayed: boolean }>(
      `/companies/${companyId}/operator-decisions`,
      input,
    ),
  get: (id: string) =>
    api.get<{ data: OperatorDecisionView }>(`/operator-decisions/${id}`).then((response) => response.data),
  resolve: (id: string, input: ResolveOperatorDecisionInput) =>
    api.post<{ data: OperatorDecisionResolutionResponse }>(`/operator-decisions/${id}/resolve`, input)
      .then((response) => response.data),
  retryContinuation: (id: string) =>
    api.post<{ data: OperatorDecisionResolutionResponse }>(
      `/operator-decisions/${id}/retry-continuation`,
      {},
    ).then((response) => response.data),
};
