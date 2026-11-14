// server/src/services/knowledge-text-normalizer.ts
//
// [파일 목적] 지식 패턴 관련도 엔진(T1b — mistology 흡수)의 텍스트 정규화 순수 모듈.
//   질의·카드 양쪽을 같은 규칙으로 정규화해 노이즈(스택트레이스 장식·조사·대소문자)에
//   강한 매칭을 만든다. DB·기존 서비스 import 금지 — 순수 함수만.
// [비고] 경로 정규화 기본 규칙(백슬래시→슬래시, a/·b/ diff 접두사, 중복 슬래시, 선행 ./)은
//   T1a 공유 계약을 그대로 쓴다 — 패키지 인덱스가 아직 이 계약을 재수출하지 않으므로
//   저장소 관례(검증자·서버의 validators 하위경로 직접 import)를 따라 규칙 이중 정의를 피한다.

import { normalizeKnowledgePatternEntityPath } from "@paperclipai/shared/validators/knowledge-pattern";

/** 스택트레이스/diff 경로 장식 제거 — `path:12:34`·`path:12`·`path(10,15)` → `path`. */
export function stripLineColumns(raw: string): string {
  return raw
    .replace(/\(\d+,\s*\d+\)$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .trim();
}

/** 코드 경로 참조 정규화 — 행·열 제거 후 공유 경로 규칙(diff 접두사·슬래시 통일) 적용. */
export function normalizeCodePathRef(raw: string): string {
  return normalizeKnowledgePatternEntityPath(stripLineColumns(raw));
}

/** 유일 파일명 — 정규화된 경로의 마지막 세그먼트. */
export function uniqueFileName(pathRef: string): string {
  const segments = pathRef.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? pathRef;
}

/** `@/` 별칭 해석 — 입력받은 별칭 맵에서 긴 키부터 접두사 치환(하드코딩 금지). */
export function resolvePathAlias(ref: string, aliasMap: Readonly<Record<string, string>>): string {
  const keys = Object.keys(aliasMap).sort((left, right) => right.length - left.length);
  for (const key of keys) {
    const root = aliasMap[key]!.replace(/\/+$/, "");
    if (ref === key) return root;
    if (ref.startsWith(`${key}/`)) {
      return normalizeKnowledgePatternEntityPath(`${root}/${ref.slice(key.length + 1)}`);
    }
  }
  return ref;
}

/** 한국어 조사 31종 — 접미사 목록 순회 전용(정규식·언어 분석기 없음). 긴 것부터 나열. */
export const KOREAN_PARTICLES: readonly string[] = [
  "에서는", "에게서",
  "에게", "에서", "으로", "한테", "보다", "처럼", "만큼", "부터", "까지", "조차", "밖에", "이라", "이나",
  "은", "는", "이", "가", "을", "를", "께", "로", "와", "과", "도", "만", "의", "에", "라", "나",
];

/** 조사 스테밍 — 목록 순회로 마지막 접미사를 1회만 제거한다(재귀 없음, 결정론적).
 *   1자 조사는 stem이 2음절 이상일 때만 제거('사과'→'사' 오식 방지). */
export function stemKoreanParticle(word: string): string {
  for (const particle of KOREAN_PARTICLES) {
    if (word.length <= particle.length || !word.endsWith(particle)) continue;
    const stem = word.slice(0, -particle.length);
    if (particle.length === 1 && stem.length < 2) continue;
    return stem;
  }
  return word;
}

/** 서브워드 분리 — camelCase/PascalCase/약어 경계(HTTPServer→http+server)·snake_case·한영 경계. */
export function splitSubWords(token: string): string[] {
  const spaced = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_+/gu, " ")
    .replace(/(\p{Script=Hangul}+)([A-Za-z0-9]+)/gu, "$1 $2")
    .replace(/([A-Za-z0-9]+)(\p{Script=Hangul}+)/gu, "$1 $2");
  return spaced
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/** 코드/워크플로 산문 불용어 — 관사·be동사·보조·접속·범용 코드 단어 중심.
 *   고빈도 도메인 단어(workflow/mission/issue)는 불용어가 아니다 — IDF가 다룬다. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "has", "have", "had", "will", "would", "can", "could", "should",
  "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "as",
  "it", "its", "this", "that", "these", "those", "not", "no", "but", "if", "then", "when", "while",
  "failed", "fails", "failing", "error", "errors",
  "함수", "실행", "처리", "발생", "경우", "문제", "사용", "통해", "위해", "때문",
  "등", "및", "또한", "그리고", "이후", "이전", "동안", "관련", "대한",
]);

/** 불용어 판정 — 도메인 단어(workflow/mission/issue)는 항상 false. */
export function isKnowledgeStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

/** 텍스트 → 정규화 토큰(중복 제거·등장순) — 문장부호 제거→서브워드→조사→불용어·길이 필터. */
export function normalizeKnowledgeTokens(text: string): string[] {
  const rawTokens = text
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    for (const part of splitSubWords(rawToken)) {
      const stemmed = stemKoreanParticle(part);
      if (stemmed.length < 2 || isKnowledgeStopword(stemmed)) continue;
      if (!seen.has(stemmed)) {
        seen.add(stemmed);
        tokens.push(stemmed);
      }
    }
  }
  return tokens;
}

/** 경로 후보 추출 — 확장자를 가진 파일경로 모양 문자열(`@` 별칭 시길 포함.
 *   `:line:col`·`(l,c)`은 정규화 시 제거된다). */
export function extractFileRefs(texts: readonly string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[@\w./\\-]+\.[\w-]+/g)) {
      const ref = match[0];
      if (ref.length < 3 || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}
