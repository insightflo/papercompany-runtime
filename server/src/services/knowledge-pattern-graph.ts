// server/src/services/knowledge-pattern-graph.ts
//
// [파일 목적] 지식 패턴 카드의 엔티티 결합 그래프 순수 모듈 — files→coupled 단방향
//   1-hop 전파만 계산한다(mistology 허브 폭발 방어). DB·기존 서비스 import 금지.
// [불변식]
//   - 단방향 1-hop: 질의 파일이 어떤 카드의 files(앵커)에 있고 다른 카드의 coupled에도
//     있으면 그 카드로 전파한다. file↔file·coupled↔coupled 동종 조인은 만들지 않는다.
//   - 허브 감쇠: 앵커 카드의 files가 3개 이상이면 그 경유 전파는 ×0.25 — 0으로 차단하지는
//     않는다(카드 수가 적은 현 운영에서 감쇠가 실용적). tight 앵커(files ≤2)가 하나라도
//     있으면 감쇠 없음.
//   - 2-hop 금지: 전파 결과를 다시 질의로 재사용하지 않는다(계층 확장은 별도 검증 단계).
// [소비] knowledge-pattern-relevance(점수 합산). via 라벨은 T1c 주입 브리핑·T3 explain이 쓴다.

import { normalizeCodePathRef, resolvePathAlias } from "./knowledge-text-normalizer.js";

const HUB_DECAY = 0.25;
const TIGHT_FILE_LIMIT = 2;

export type CouplingCardRow = {
  id: string;
  files: readonly string[];
  coupled: readonly string[];
};

export type CouplingPropagation = {
  cardId: string;
  /** 전파 경유 정규화 엔티티 — 어느 파일을 통해 연결됐는지(등장순, 결정론적). */
  via: string[];
  /** 감쇠 반영 강도 — perEntity 계수의 합. */
  strength: number;
  /** 엔티티별 감쇠 계수(1 또는 0.25) — 점수 병합 시 영역별 최고 가중치 규칙에 쓴다. */
  perEntity: ReadonlyMap<string, number>;
};

export type CouplingGraphOptions = {
  aliasMap?: Readonly<Record<string, string>>;
};

function normalizeRefs(refs: readonly string[], aliasMap: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const ref of refs) {
    const value = resolvePathAlias(normalizeCodePathRef(ref), aliasMap);
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** files→coupled 1-hop 전파 — 카드 ID → 전파 결과. 질의·카드 경로 양쪽 정규화 후 비교. */
export function propagateCoupledPatterns(
  cards: readonly CouplingCardRow[],
  queryFiles: readonly string[],
  options: CouplingGraphOptions = {},
): Map<string, CouplingPropagation> {
  const aliasMap = options.aliasMap ?? {};
  const queryRefs = normalizeRefs(queryFiles, aliasMap);
  if (queryRefs.length === 0 || cards.length === 0) return new Map();

  // 엔티티 → 앵커 감쇠 계수(가장 낮은 감쇠, 즉 가장 높은 계수 채택).
  const anchorFactorByEntity = new Map<string, number>();
  // 엔티티 → coupled에 그 엔티티를 가진 카드들.
  const coupledCardsByEntity = new Map<string, string[]>();

  for (const card of cards) {
    const files = normalizeRefs(card.files ?? [], aliasMap);
    const coupled = normalizeRefs(card.coupled ?? [], aliasMap);
    const factor = files.length <= TIGHT_FILE_LIMIT ? 1 : HUB_DECAY;
    for (const entity of files) {
      const previous = anchorFactorByEntity.get(entity);
      if (previous === undefined || factor > previous) anchorFactorByEntity.set(entity, factor);
    }
    for (const entity of coupled) {
      const bucket = coupledCardsByEntity.get(entity) ?? [];
      bucket.push(card.id);
      coupledCardsByEntity.set(entity, bucket);
    }
  }

  const result = new Map<string, { cardId: string; via: string[]; strength: number; perEntity: Map<string, number> }>();
  for (const entity of queryRefs) {
    const factor = anchorFactorByEntity.get(entity);
    if (factor === undefined) continue; // files 측 앵커 없는 질의 파일은 전파 근거가 없다(1-hop 불변식)
    for (const cardId of coupledCardsByEntity.get(entity) ?? []) {
      const entry = result.get(cardId) ?? { cardId, via: [], strength: 0, perEntity: new Map<string, number>() };
      if (!entry.via.includes(entity)) {
        entry.via.push(entity);
        entry.perEntity.set(entity, factor);
        entry.strength += factor;
      }
      result.set(cardId, entry);
    }
  }
  return new Map<string, CouplingPropagation>(result);
}
