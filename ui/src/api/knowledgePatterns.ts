// ui/src/api/knowledgePatterns.ts
//
// [목적] 사고→패턴 지식 위키 카드 API(/api/companies/:id/knowledge-patterns) 클라이언트.
//   카드 등록/대체는 오너·운영자가 구조화 API로 수행한다. 보드 UI는 조회 + 자동 초안(draft)
//   승인만 수행한다(P1 — 승인은 사람 전용 경로).
// [연결] consumer: ui/src/pages/AgentWiki.tsx.
import { api } from "./client";

export interface KnowledgePatternEvidenceRef {
  type: string;
  id: string;
  note?: string;
}

export interface KnowledgePatternCardDto {
  id: string;
  companyId: string;
  kind: string;
  title: string;
  summary: string;
  evidence: KnowledgePatternEvidenceRef[];
  symptoms: string | null;
  rootCause: string | null;
  whatWorked: string | null;
  scopeTags: string[];
  source: string;
  status: string;
  defectSignature: string | null;
  createdByAgentId: string | null;
  supersededById: string | null;
  createdAt: string;
}

export interface KnowledgePatternsResponse {
  patterns: KnowledgePatternCardDto[];
}

export const knowledgePatternsApi = {
  list: (companyId: string, options?: { q?: string; includeSuperseded?: boolean }): Promise<KnowledgePatternsResponse> => {
    const params = new URLSearchParams();
    if (options?.q?.trim()) params.set("q", options.q.trim());
    if (options?.includeSuperseded) params.set("includeSuperseded", "true");
    const query = params.toString();
    return api.get<KnowledgePatternsResponse>(`/companies/${companyId}/knowledge-patterns${query ? `?${query}` : ""}`);
  },
  /** 자동 초안(draft) 카드 승인 — draft→active. 사람(보드) 전용. */
  approve: (companyId: string, patternId: string): Promise<{ card: KnowledgePatternCardDto }> =>
    api.post<{ card: KnowledgePatternCardDto }>(`/companies/${companyId}/knowledge-patterns/${patternId}/approve`, {}),
};
