// server/src/services/missions/mission-owner-related-patterns.ts
//
// [파일 목적] 오너 액션(언블록) 생성 시점에 회사 지식 위키에서 이번 미션과
//   관련된 사고 패턴 카드를 골라 오너 결정 표면에 띄운다("방아쇠" 조각 —
//   지침 줄만으로 오너가 스스로 루프를 돌리지 않는 문제의 구조적 해결).
// [불변식]
//   - 주입은 제목+카드 id 요약 라인만(설계 계약: 링크+제목, 본문 주입 아님).
//     symptoms/rootCause/whatWorked 본문은 오너가 GET으로 직접 조회한다.
//   - 회사 스코프 검색 결과만 대상(규칙 1). 점수는 결정론적 토큰/태그 중복 — LLM 없음.

import type { Db } from "@paperclipai/db";
import { knowledgePatternsService, type KnowledgePattern } from "../knowledge-patterns.js";

const CANDIDATE_POOL_LIMIT = 50;
const DEFAULT_RESULT_LIMIT = 3;
const MIN_RELEVANCE_SCORE = 2;
const TAG_MATCH_SCORE = 3;

export type RelatedKnowledgePattern = {
  id: string;
  title: string;
  score: number;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

/** 결정론적 관련도: 스코프태그 직접命中 + 문맥 토큰 중복(제목·증상·근본원인에서). */
export function selectRelatedKnowledgePatterns(
  cards: Array<Pick<KnowledgePattern, "id" | "title" | "symptoms" | "rootCause" | "scopeTags">>,
  contextTexts: string[],
  limit: number = DEFAULT_RESULT_LIMIT,
): RelatedKnowledgePattern[] {
  const contextTokens = new Set(tokenize(contextTexts.join(" ")));
  if (contextTokens.size === 0) return [];

  const scored = cards.map((card) => {
    const cardTokens = new Set([
      ...tokenize(`${card.title ?? ""} ${card.symptoms ?? ""} ${card.rootCause ?? ""}`),
      ...(card.scopeTags ?? []).map((tag) => tag.toLowerCase()),
    ]);
    let score = 0;
    for (const tag of card.scopeTags ?? []) {
      if (contextTokens.has(tag.toLowerCase())) score += TAG_MATCH_SCORE;
    }
    for (const token of cardTokens) {
      if (token.length >= 2 && contextTokens.has(token)) score += 1;
    }
    return { id: card.id, title: card.title, score };
  });

  return scored
    .filter((entry) => entry.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

/** 회사 스코프 카드 검색 → 관련 카드 선택. 실패 시 빈 배열(오너 액션 생성은 계속). */
export async function findRelatedKnowledgePatterns(
  db: Db,
  companyId: string,
  contextTexts: string[],
): Promise<RelatedKnowledgePattern[]> {
  const cards = await knowledgePatternsService(db).search({ companyId, limit: CANDIDATE_POOL_LIMIT });
  return selectRelatedKnowledgePatterns(cards, contextTexts);
}
