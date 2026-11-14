// server/src/services/knowledge-pattern-relevance.ts
//
// [파일 목적] 지식 패턴 카드 관련도 순수 선택기 — 카드↔문맥의 결정론적 매칭.
//   소비자: 오너 언블록 방아쇠(mission-owner-related-patterns), 카드 중복 힌트(knowledge-patterns),
//   T1c 검색 랭킹. LLM 없음, 프로즈 파싱 없음 — 구조화 필드·토큰 중복만.
// [T1b — mistology 흡수] 단일 카드 토큰 카운트에서 결합 그래프+정규화 가중치 엔진으로 확장:
//   - 엔티티 가중치: errorSignatures 10 > symbols 6 > files 3 > coupled 1. 같은 엔티티가 여러
//     영역에 걸치면 최고 가중치 1회만 합산(태그 3점+본문 토큰 1점의 기존 가산 계약은 유지).
//   - TF-IDF: 희소 심볼/파일에 log2(1+N/df) 부스트를 [1,2]로 클램프 — 고빈도 단어
//     (workflow/mission/issue)는 부스트가 1로 붕괴해 인플레이션되지 않는다.
//   - 그래프 1-hop 전파(files→coupled, 허브 감쇠) 합산 + via 경유 라벨.
//   - requireMultiBody: 본문 토큰 1개만 겹친 카드는 0점(단일 토큰 우연 일치 차단).
//     단 files/symbols/errorSignatures 정확 일치는 예외(태그는 기존 계약상 생존 신호).
// [비고] knowledge-patterns.ts와 서로 import하지 않는다(순환 방지).

import type { KnowledgePattern } from "./knowledge-patterns.js";
import {
  extractFileRefs,
  normalizeCodePathRef,
  normalizeKnowledgeTokens,
  resolvePathAlias,
} from "./knowledge-text-normalizer.js";
import { propagateCoupledPatterns } from "./knowledge-pattern-graph.js";

export const DEFAULT_RELEVANCE_SCORE_LIMIT = 3;
const MIN_RELEVANCE_SCORE = 2;
const TAG_MATCH_SCORE = 3;
const SIGNATURE_WEIGHT = 10;
const SYMBOL_WEIGHT = 6;
const FILE_WEIGHT = 3;
const COUPLED_WEIGHT = 1;
const IDF_CEILING = 2;
const MIN_ENTITY_KEY_LENGTH = 3;

export type RelatedKnowledgePattern = {
  id: string;
  title: string;
  score: number;
  /** 1-hop 결합 전파 경유 엔티티(T1c 주입 브리핑·T3 explain용 — 전파 기여가 없으면 생략). */
  via?: string[];
};

export type RelevanceOptions = {
  /** 경로 별칭 맵(예: { "@": "server/src" }) — 제공될 때만 질의·카드 경로에 적용. */
  aliasMap?: Readonly<Record<string, string>>;
};

type RelevanceCard = Pick<KnowledgePattern, "id" | "title" | "symptoms" | "rootCause" | "scopeTags"> &
  Partial<Pick<KnowledgePattern, "summary" | "files" | "symbols" | "coupled" | "errorSignatures">>;

/** 엔티티 영역 히트 — 병합 후 최고 가중치 1회 합산. boostable/strong은 가드·IDF 판정용. */
type EntityHit = { weight: number; boostable: boolean; strong: boolean };

const asArray = (value: readonly string[] | undefined): string[] => [...(value ?? [])];

const collapseKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/** TF-IDF 부스트 — log2(1 + N/df)를 [1, IDF_CEILING]로 클램프(희소 상승·고빈도 붕괴 방어). */
function idfBoost(documentFrequency: number, corpusSize: number): number {
  if (corpusSize <= 1 || documentFrequency <= 0) return 1;
  return Math.min(IDF_CEILING, Math.max(1, Math.log2(1 + corpusSize / documentFrequency)));
}

function mergeHit(hits: Map<string, EntityHit>, key: string, hit: EntityHit): void {
  const previous = hits.get(key);
  if (!previous) {
    hits.set(key, hit);
    return;
  }
  hits.set(key, {
    weight: Math.max(previous.weight, hit.weight),
    boostable: previous.boostable || hit.boostable,
    strong: previous.strong || hit.strong,
  });
}

/** 결정론적 관련도: 스코프태그 직접命中 + 정규화 토큰 중복 + 구조화 엔티티 가중치 + 1-hop 전파. */
export function selectRelatedKnowledgePatterns(
  cards: readonly RelevanceCard[],
  contextTexts: readonly string[],
  limit: number = DEFAULT_RELEVANCE_SCORE_LIMIT,
  options: RelevanceOptions = {},
): RelatedKnowledgePattern[] {
  const contextText = contextTexts.join(" ");
  const contextTokens = new Set(normalizeKnowledgeTokens(contextText));
  const contextCorpus = collapseKey(contextText);
  const aliasMap = options.aliasMap ?? {};
  const fileRefSet = new Set(
    extractFileRefs(contextTexts)
      .map((ref) => resolvePathAlias(normalizeCodePathRef(ref), aliasMap))
      .filter((ref) => ref.length > 0),
  );
  if (contextTokens.size === 0 && fileRefSet.size === 0) return [];

  // 코퍼스 통계: 파일/심볼의 문서 빈도(IDF) — 카드별 정규화 결과를 재사용한다.
  const fileRefsByCard = new Map<string, string[]>();
  const symbolKeysByCard = new Map<string, string[]>();
  const fileDf = new Map<string, number>();
  const symbolDf = new Map<string, number>();
  for (const card of cards) {
    const files = asArray(card.files)
      .map((ref) => resolvePathAlias(normalizeCodePathRef(ref), aliasMap))
      .filter((ref) => ref.length > 0);
    const symbols = asArray(card.symbols).map(collapseKey).filter((key) => key.length > 0);
    fileRefsByCard.set(card.id, files);
    symbolKeysByCard.set(card.id, symbols);
    for (const ref of new Set(files)) fileDf.set(ref, (fileDf.get(ref) ?? 0) + 1);
    for (const key of new Set(symbols)) symbolDf.set(key, (symbolDf.get(key) ?? 0) + 1);
  }

  const propagation = propagateCoupledPatterns(
    cards.map((card) => ({ id: card.id, files: asArray(card.files), coupled: asArray(card.coupled) })),
    [...fileRefSet],
    { aliasMap },
  );

  const scored = cards.map((card) => {
    // 기존 계약 유지: 본문 토큰 세트에 스코프태그(소문자)를 포함한다(태그 단어 토큰 중복 +1).
    const bodyTokens = new Set([
      ...normalizeKnowledgeTokens(`${card.title ?? ""} ${card.symptoms ?? ""} ${card.rootCause ?? ""}`),
      ...normalizeKnowledgeTokens(card.summary ?? ""),
      ...(card.scopeTags ?? []).map((tag) => tag.toLowerCase()),
    ]);
    let score = 0;
    let tagHits = 0;
    for (const tag of card.scopeTags ?? []) {
      if (contextTokens.has(tag.toLowerCase())) {
        score += TAG_MATCH_SCORE;
        tagHits += 1;
      }
    }
    let bodyHits = 0;
    for (const token of bodyTokens) {
      if (token.length >= 2 && contextTokens.has(token)) {
        score += 1;
        bodyHits += 1;
      }
    }

    // 엔티티 영역(서명>심볼>파일>결합) — 동일 엔티티 다중 영역 히트는 최고 가중치 1회.
    const hits = new Map<string, EntityHit>();
    for (const signature of asArray(card.errorSignatures)) {
      const key = collapseKey(signature);
      if (key.length >= MIN_ENTITY_KEY_LENGTH && contextCorpus.includes(key)) {
        mergeHit(hits, `sig:${key}`, { weight: SIGNATURE_WEIGHT, boostable: false, strong: true });
      }
    }
    for (const symbol of symbolKeysByCard.get(card.id) ?? []) {
      if (symbol.length >= MIN_ENTITY_KEY_LENGTH && contextCorpus.includes(symbol)) {
        mergeHit(hits, `sym:${symbol}`, { weight: SYMBOL_WEIGHT, boostable: true, strong: true });
      }
    }
    for (const ref of fileRefsByCard.get(card.id) ?? []) {
      if (fileRefSet.has(ref)) mergeHit(hits, `file:${ref}`, { weight: FILE_WEIGHT, boostable: true, strong: true });
    }
    for (const ref of asArray(card.coupled)
      .map((raw) => resolvePathAlias(normalizeCodePathRef(raw), aliasMap))
      .filter((ref) => ref.length > 0)) {
      if (fileRefSet.has(ref)) mergeHit(hits, `file:${ref}`, { weight: COUPLED_WEIGHT, boostable: false, strong: false });
    }

    // 1-hop 전파 병합: 엔티티별 직접 가중치와 전파 강도(×coupled 가중치)의 최댓값.
    const via: string[] = [];
    const propagated = propagation.get(card.id);
    if (propagated) {
      for (const [entity, factor] of propagated.perEntity) {
        if (factor > 0) via.push(entity);
        mergeHit(hits, `file:${entity}`, { weight: factor * COUPLED_WEIGHT, boostable: false, strong: false });
      }
    }

    let hasStrongEntity = false;
    for (const [key, hit] of hits) {
      if (hit.strong) hasStrongEntity = true;
      const multiplier = hit.boostable
        ? key.startsWith("sym:")
          ? idfBoost(symbolDf.get(key.slice(4)) ?? 1, cards.length)
          : idfBoost(fileDf.get(key.slice(5)) ?? 1, cards.length)
        : 1;
      score += hit.weight * multiplier;
    }

    // requireMultiBody: 본문 토큰 1개만 겹치고 태그·강한 엔티티 근거가 없으면 우연 일치로 0점.
    if (bodyHits === 1 && tagHits === 0 && !hasStrongEntity) score = 0;

    const entry: RelatedKnowledgePattern = { id: card.id, title: card.title, score };
    if (via.length > 0 && score > 0) entry.via = via;
    return entry;
  });

  return scored
    .filter((entry) => entry.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}
