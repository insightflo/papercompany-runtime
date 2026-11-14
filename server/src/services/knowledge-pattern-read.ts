// server/src/services/knowledge-pattern-read.ts
//
// [파일 목적] 사고→패턴 지식 위키의 읽기 전용 검증·조회 모듈(T1c — knowledge-patterns.ts
//   300줄 상한 감축 분리). 입력 판독기(readTrimmed/readEvidence/readTags), 구조화 엔티티
//   검증(readEntities), 근거 실재성 검증(assertEvidenceExists), 검색(searchKnowledgePatterns)을
//   제공한다. 쓰기 경로(create의 트랜잭션 supersede 가드·게이트 호출 구조)는
//   knowledge-patterns.ts에 그대로 남는다 — 이 모듈은 게이트가 재사용하는 조회 부품일 뿐이다.
// [불변식] readTrimmed/readEvidence/readTags/assertEvidenceExists/evidenceRowExists는
//   기존 로직의 순수 이동+export다(로직 변경 없음). searchKnowledgePatterns는 T1c로
//   관련도 재정렬만 추가했다 — DB 필터를 통과한 행을 재정렬이 버리지 않는다(기존 카드 회귀 0).

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyKnowledgePatterns,
  heartbeatRuns,
  issues,
  missions,
  workflowRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { knowledgePatternEntitiesSchema } from "@paperclipai/shared/validators/knowledge-pattern";
import { selectRelatedKnowledgePatterns } from "./knowledge-pattern-relevance.js";
import type { KnowledgePattern } from "./knowledge-patterns.js";

const EVIDENCE_TYPES: readonly string[] = ["mission", "workflow_run", "issue", "transition_event", "pr", "heartbeat_run"];

export const KINDS: readonly string[] = ["failure_mode", "success_recipe", "constraint"];

export const KNOWLEDGE_PATTERN_STATUS_DRAFT = "draft";
export const KNOWLEDGE_PATTERN_STATUS_ACTIVE = "active";

export const TITLE_MAX = 200;
export const SUMMARY_MAX = 1200;
export const TEXT_MAX = 2000;
const TAGS_MAX = 8;
const EVIDENCE_MAX = 10;

export function readTrimmed(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value == null) {
    if (required) throw new Error(`knowledge pattern ${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`knowledge pattern ${field} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed === "") throw new Error(`knowledge pattern ${field} must not be empty`);
  if (trimmed.length > max) throw new Error(`knowledge pattern ${field} exceeds ${max} chars`);
  return trimmed === "" ? null : trimmed;
}

export function readEvidence(value: unknown): Array<Record<string, unknown>> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > EVIDENCE_MAX) {
    throw new Error(`knowledge pattern evidence must be an array of at most ${EVIDENCE_MAX} refs`);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("knowledge pattern evidence entries must be objects");
    }
    const record = item as Record<string, unknown>;
    if (!EVIDENCE_TYPES.includes(String(record.type))) {
      throw new Error(`knowledge pattern evidence type must be one of ${EVIDENCE_TYPES.join(", ")}`);
    }
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    if (!id) throw new Error("knowledge pattern evidence entries require a non-empty id");
    const note = typeof record.note === "string" ? record.note.trim().slice(0, 300) : null;
    return { type: String(record.type), id, ...(note ? { note } : {}) };
  });
}

export function readTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > TAGS_MAX) {
    throw new Error(`knowledge pattern scopeTags must be an array of at most ${TAGS_MAX}`);
  }
  return value.map((tag) => String(tag).trim().toLowerCase().slice(0, 40)).filter((tag) => tag !== "");
}

/** [T1c 구조화 결합 메타데이터] create 입력의 files/symbols/coupled/errorSignatures를
 *  공유 Zod 계약으로 검증·정규화(diff 접두사 제거·중복 제거·상한)한다. 누락 시 빈 배열
 *  (기존 카드 호환 — DB notNull default '{}'와 동일 해석). 형식 오류는 "knowledge pattern
 *  entity ..." 접두사 메시지로 던져 라우트가 422로 매핑하게 한다. */
export function readEntities(input: {
  files?: unknown;
  symbols?: unknown;
  coupled?: unknown;
  errorSignatures?: unknown;
}): { files: string[]; symbols: string[]; coupled: string[]; errorSignatures: string[] } {
  const parsed = knowledgePatternEntitiesSchema.safeParse({
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    coupled: input.coupled ?? [],
    errorSignatures: input.errorSignatures ?? [],
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.join(".") ?? "root";
    throw new Error(`knowledge pattern entity metadata is invalid (${path}: ${first?.message ?? "validation failed"})`);
  }
  return parsed.data;
}

/** [근거 실재성 검증] evidence 참조가 실제 행을 가리키는지 확인한다(2026-11-14 결함 수정 ⓑ).
 *  검증 가능 타입: mission/workflow_run/issue/transition_event/heartbeat_run — 모두 uuid PK.
 *  'pr'은 외부 GitHub 참조로 DB 테이블이 없어 형식 검증만 적용(존재 검증은 흡수 Top-2에서 별도 논의).
 *  위조 근거(존재하지 않는 id)로 즉시 active 카드가 되는 것을 막는다. */
export async function assertEvidenceExists(db: Db, evidence: Array<Record<string, unknown>>): Promise<void> {
  for (const entry of evidence) {
    const type = String(entry.type);
    const id = String(entry.id);
    if (type === "pr") continue;
    if (!isUuidLike(id)) {
      throw new Error(`knowledge pattern evidence ${type} id must be a uuid (got "${id.slice(0, 40)}")`);
    }
    const exists = await evidenceRowExists(db, type, id);
    if (!exists) {
      throw new Error(`knowledge pattern evidence ${type} ${id} does not exist`);
    }
  }
}

export async function evidenceRowExists(db: Db, type: string, id: string): Promise<boolean> {
  switch (type) {
    case "mission": {
      const rows = await db.select({ id: missions.id }).from(missions).where(eq(missions.id, id)).limit(1);
      return rows.length > 0;
    }
    case "workflow_run": {
      const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
      return rows.length > 0;
    }
    case "issue": {
      const rows = await db.select({ id: issues.id }).from(issues).where(eq(issues.id, id)).limit(1);
      return rows.length > 0;
    }
    case "transition_event": {
      const rows = await db
        .select({ id: workflowTransitionEvents.id })
        .from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.id, id))
        .limit(1);
      return rows.length > 0;
    }
    case "heartbeat_run": {
      const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).limit(1);
      return rows.length > 0;
    }
    default:
      return true;
  }
}

export type KnowledgePatternSearchInput = {
  companyId: string;
  kind?: string | null;
  tags?: readonly string[] | null;
  q?: string | null;
  /** [T1c] 관련도 재정렬용 엔티티 질의(선택). 미제공 시 제목/요약 토큰만으로 현행 호환 랭킹. */
  files?: readonly string[] | null;
  symbols?: readonly string[] | null;
  includeSuperseded?: boolean;
  includeDrafts?: boolean;
  limit?: number;
};

/** 검색 — superseded 기본 제외. kind/tags/q(제목·요약·증상·근본원인 ILIKE) 필터.
 *  draft 초안은 기본 제외(includeDrafts=true일 때만 노출 — 승인 화면 전용).
 *  [T1c] q·files·symbols 질의가 있으면 결과를 관련도 엔진(T1b)으로 재정렬한다 — 질의
 *  정규화는 엔진 내부 normalizer가 수행하므로 여기선 원문을 넘긴다. 재정렬은 DB 필터 통과
 *  행을 버리지 않고 순서만 바꾼다(엔진 최소점 미만 행은 종전 createdAt desc 순 뒤에 잔류). */
export async function searchKnowledgePatterns(db: Db, input: KnowledgePatternSearchInput): Promise<KnowledgePattern[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const q = input.q?.trim();
  const conditions = [eq(companyKnowledgePatterns.companyId, input.companyId)];
  if (!input.includeSuperseded) {
    conditions.push(isNull(companyKnowledgePatterns.supersededById));
  }
  if (!input.includeDrafts) {
    conditions.push(eq(companyKnowledgePatterns.status, KNOWLEDGE_PATTERN_STATUS_ACTIVE));
  }
  if (input.kind && KINDS.includes(input.kind)) {
    conditions.push(eq(companyKnowledgePatterns.kind, input.kind));
  }
  const tags = readTags(input.tags);
  if (tags.length > 0) {
    conditions.push(sql`${companyKnowledgePatterns.scopeTags} && ARRAY[${sql.join(tags.map((tag) => sql`${tag}`), sql`, `)}]::text[]`);
  }
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const textCondition = or(
      ilike(companyKnowledgePatterns.title, pattern),
      ilike(companyKnowledgePatterns.summary, pattern),
      ilike(companyKnowledgePatterns.symptoms, pattern),
      ilike(companyKnowledgePatterns.rootCause, pattern),
    );
    if (textCondition) conditions.push(textCondition);
  }
  const rows = await db
    .select()
    .from(companyKnowledgePatterns)
    .where(and(...conditions))
    .orderBy(desc(companyKnowledgePatterns.createdAt))
    .limit(limit);

  const entityQueries = [...(input.files ?? []), ...(input.symbols ?? [])].filter((item) => item.trim().length > 0);
  if (!q && entityQueries.length === 0) return rows;
  const ranked = selectRelatedKnowledgePatterns(rows, [q ?? "", ...entityQueries], rows.length);
  const scoreById = new Map(ranked.map((entry) => [entry.id, entry.score]));
  // 안정 정렬 — 무득점 행은 종전 순서(createdAt desc)를 유지한 채 득점 행 뒤에 잔류한다.
  return [...rows].sort((left, right) => (scoreById.get(right.id) ?? 0) - (scoreById.get(left.id) ?? 0));
}
