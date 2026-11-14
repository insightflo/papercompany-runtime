import { z } from "zod";

// [파일 목적] 사고→패턴 지식 카드(company_knowledge_patterns)의 구조화 결함 결합
//   메타데이터(files/symbols/coupled/errorSignatures) 공유 Zod 계약 —
//   2026-11-14 mistology 흡수 T1a. DB·엔진(T1b)·검색 랭킹(T1c)이 동일한 정규화
//   규칙을 공유하도록 순수 함수로만 구성한다(DB/서버 import 금지).
// [정규화 규칙] 파일 경로(files/coupled): 백슬래시→슬래시, git diff 접두사(a/, b/)
//   제거, 선행 ./ 제거, 중복 슬래시 축약. 모든 배열은 정규화·trim 후 중복 제거하고
//   그 결과에 개수 상한을 적용한다(정규화 후 동일 값은 1개만 유지).

const MAX_ENTITY_ITEMS = 12;
const MAX_ERROR_SIGNATURES = 6;
const MAX_ERROR_SIGNATURE_LENGTH = 200;

/** 파일 경로 정규화 — 순수 함수(T1b normalizer도 같은 규칙으로 재사용). */
export function normalizeKnowledgePatternEntityPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^(?:a|b)\//, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

// 단일 엔티티 참조: trim 후 빈 값 거부 → 경로 정규화 → 정규화 결과가 빈 값이면 거부.
export const knowledgePatternEntityRefSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeKnowledgePatternEntityPath)
  .refine((value) => value.length > 0, {
    message: "entity ref is empty after path normalization",
  });

const dedupe = (items: string[]): string[] => Array.from(new Set(items));

/** 정규화 후 중복 제거 → 개수 상한(중복 제거 결과 기준). */
const filesField = z
  .array(knowledgePatternEntityRefSchema)
  .transform(dedupe)
  .refine((items) => items.length <= MAX_ENTITY_ITEMS, {
    message: `at most ${MAX_ENTITY_ITEMS} files after dedupe`,
  })
  .default([]);

const symbolsField = z
  .array(z.string().trim().min(1))
  .transform(dedupe)
  .refine((items) => items.length <= MAX_ENTITY_ITEMS, {
    message: `at most ${MAX_ENTITY_ITEMS} symbols after dedupe`,
  })
  .default([]);

/** coupled는 files와 동일 경로 정규화를 적용한다(결합 엔티티도 파일/모듈 경로). */
const coupledField = z
  .array(knowledgePatternEntityRefSchema)
  .transform(dedupe)
  .refine((items) => items.length <= MAX_ENTITY_ITEMS, {
    message: `at most ${MAX_ENTITY_ITEMS} coupled entities after dedupe`,
  })
  .default([]);

const errorSignaturesField = z
  .array(z.string().trim().min(1).max(MAX_ERROR_SIGNATURE_LENGTH))
  .transform(dedupe)
  .refine((items) => items.length <= MAX_ERROR_SIGNATURES, {
    message: `at most ${MAX_ERROR_SIGNATURES} error signatures after dedupe`,
  })
  .default([]);

// 카드 단위 구조화 엔티티 메타데이터. 모든 필드는 생략 가능하며 생략 시 빈 배열로
// 해석된다(DB notNull default '{}' 와 대응 — T1c 소비 전까지 기존 카드는 전부 빈 값).
export const knowledgePatternEntitiesSchema = z.object({
  files: filesField,
  symbols: symbolsField,
  coupled: coupledField,
  errorSignatures: errorSignaturesField,
});

export type KnowledgePatternEntities = z.infer<typeof knowledgePatternEntitiesSchema>;
