// server/src/services/knowledge-pattern-relevance.ts
//
// [파일 목적] 지식 패턴 카드 관련도 순수 선택기 — 카드↔문맥의 결정론적 매칭.
//   소비자: 오너 언블록 방아쇠(mission-owner-related-patterns), 카드 중복 힌트(knowledge-patterns).
//   LLM 없음, 프로즈 파싱 없음 — 스코프태그 직접命中 + 토큰 중복만.
// [비고] knowledge-patterns.ts와 서로 import하지 않도록 이 중립 파일에 둔다(순환 방지).

import type { KnowledgePattern } from "./knowledge-patterns.js";

export const DEFAULT_RELATED_PATTERN_LIMIT = 3;
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
  limit: number = DEFAULT_RELATED_PATTERN_LIMIT,
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
