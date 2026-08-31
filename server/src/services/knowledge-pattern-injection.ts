// server/src/services/knowledge-pattern-injection.ts
//
// [purpose] P2 — 사람 큐레이션 패턴 카드의 스텝 디스패치 관련도 주입(측정 롤아웃).
//   active + audience='agent' + 신선도 창 내 카드만 후보. 결정론적 관련도 선택기
//   (knowledge-pattern-relevance, LLM 없음)로 상위 K(≤2)를 골라 formatWikiLessons 스타일의
//   짧은 한국어 섹션으로 만든다.
//
// [계약 — #163 교훈(WikiSkill ablation) 준수]
//   - 기계 카운터 위키(agent_wiki_entries)와 혼용 금지 — 이 모듈은 카드만 다룬다.
//   - fail-closed: audience 기본 'ops' = 주입 없음. 플래그 off면 아예 호출되지 않는다.
//   - 길이 상한: 카드당 제목/증상/해결 절단 — 주입량은 소량(≤2카드)으로 유계.
//
// [측정 롤아웃] injectionGroupFor가 결정론적 50/50 군 배정을 제공하고, 호출부(heartbeat)는
//   군+카드 id를 스텝런 메타데이터에 기록해 주입군/비주입군 성공률 비교를 가능하게 한다.

import { createHash } from "node:crypto";
import { and, gte, isNull, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledgePatterns } from "@paperclipai/db";
import { selectRelatedKnowledgePatterns } from "./knowledge-pattern-relevance.js";

export const PATTERN_INJECTION_LIMIT = 2;
/** 신선도 창 — 큐레이션 지식은 카운터보다 오래 유효하므로 위키(14일)보다 길게. */
export const PATTERN_INJECTION_FRESH_DAYS = 90;

const TITLE_MAX = 80;
const SYMPTOM_MAX = 120;
const SOLUTION_MAX = 160;

export type PatternInjectionGroup = "injection" | "control";

/** 결정론적 군 배정 — 같은 키는 항상 같은 군(재시도/재발행에도 군 고정). */
export function injectionGroupFor(key: string): PatternInjectionGroup {
  return createHash("sha256").update(key, "utf8").digest()[0]! < 128 ? "injection" : "control";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** 주입 후보 — active + audience='agent' + 신선도 창 내 + superseded 아님. */
export async function listInjectableCards(
  db: Db,
  companyId: string,
  now: Date = new Date(),
) {
  const since = new Date(now.getTime() - PATTERN_INJECTION_FRESH_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(companyKnowledgePatterns)
    .where(and(
      eq(companyKnowledgePatterns.companyId, companyId),
      eq(companyKnowledgePatterns.status, "active"),
      eq(companyKnowledgePatterns.audience, "agent"),
      isNull(companyKnowledgePatterns.supersededById),
      gte(companyKnowledgePatterns.createdAt, since),
    ));
}

/** 관련도 상위 K 선택 — 결정론적 토큰/태그 매칭(점수 ≥2 미만 탈락). 문맥이 없으면 빈 배열. */
export async function selectCardsForInjection(
  db: Db,
  input: { companyId: string; contextTexts: readonly string[]; limit?: number },
) {
  const limit = Math.min(input.limit ?? PATTERN_INJECTION_LIMIT, PATTERN_INJECTION_LIMIT);
  const cards = await listInjectableCards(db, input.companyId);
  if (cards.length === 0) return [];
  const related = selectRelatedKnowledgePatterns(cards, [...input.contextTexts], limit);
  const cardById = new Map(cards.map((card) => [card.id, card]));
  return related.map((entry) => cardById.get(entry.id)).filter((card) => card != null);
}

/** formatWikiLessons 스타일의 한국어 섹션. 후보가 없으면 null(섹션 미생성). */
export function formatKnowledgePatternCards(
  cards: Array<Pick<typeof companyKnowledgePatterns.$inferSelect, "id" | "title" | "symptoms" | "whatWorked">>,
): string | null {
  if (cards.length === 0) return null;
  const lines = cards.map((card) => {
    const symptom = card.symptoms ? truncate(card.symptoms, SYMPTOM_MAX) : null;
    const solution = card.whatWorked ? truncate(card.whatWorked, SOLUTION_MAX) : null;
    const parts = [`[패턴] ${truncate(card.title, TITLE_MAX)}`];
    if (symptom) parts.push(`증상: ${symptom}`);
    if (solution) parts.push(`해결: ${solution}`);
    return `- ${parts.join(" — ")}`;
  });
  return ["## 과거 사고 패턴 참고 (사람 검수 카드)", ...lines].join("\n");
}
