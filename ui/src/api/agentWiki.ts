// ui/src/api/agentWiki.ts
//
// [목적] core agent-wiki 조회 API(/api/companies/:id/agent-wiki) 클라이언트.
//   entries(축적 교훈) + timeseries(최근 실패 추이) + summary를 한 번에 가져온다.
// [연결] consumer: ui/src/pages/AgentWiki.tsx.
import { api } from "./client";

export interface AgentWikiEntryDto {
  id: string;
  companyId: string;
  agentId: string;
  missionId: string | null;
  pattern: string;
  cause: string;
  solution: string;
  errorCode: string | null;
  stepId: string | null;
  frequency: number;
  status: string;
  createdAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface AgentWikiTimeseriesPoint {
  day: string; // YYYY-MM-DD (KST)
  errorCode: string | null;
  count: number;
}

export interface AgentWikiSummary {
  totalEntries: number;
  activeEntries: number;
  resolvedEntries: number;
  totalHits: number;
}

export interface AgentWikiResponse {
  entries: AgentWikiEntryDto[];
  timeseries: AgentWikiTimeseriesPoint[];
  summary: AgentWikiSummary;
}

export const agentWikiApi = {
  get: (companyId: string, days = 14): Promise<AgentWikiResponse> =>
    api.get<AgentWikiResponse>(`/companies/${companyId}/agent-wiki?days=${days}`),
};
