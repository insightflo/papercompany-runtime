// server/src/services/knowledge-patterns.ts
//
// [파일 목적] 사고→패턴 지식 위키 서비스 — company_knowledge_patterns 테이블의
//   append-only 큐레이션 카드 생성/검색. 설계: artifacts doc/plans/2026-08-28-incident-pattern-knowledge-wiki.md
// [불변식]
//   - append-only: 수정 API 없음. 대체는 supersedeId로 새 카드 발행 + 이전 카드 링크 갱신.
//   - 회사 스코프 필수(규칙 1). 검색/대체 대상은 같은 회사로 제한.
//   - 구조화 레코드만 권위(규칙 8) — evidence는 {type,id,note} 배열, 프로즈 파싱 없음.
//   - 생성 시 activity log 기록.
// [소비] 미션 오너 진단/기획 검색, 자기개선 근거 참조. 실행 프롬프트 주입 금지(계약).

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledgePatterns, activityLog } from "@paperclipai/db";

export type KnowledgePatternKind = "failure_mode" | "success_recipe" | "constraint";
export type KnowledgePatternSource = "mission_owner_compile" | "agent_candidate" | "operator";

const KINDS: readonly string[] = ["failure_mode", "success_recipe", "constraint"];
const SOURCES: readonly string[] = ["mission_owner_compile", "agent_candidate", "operator"];
const EVIDENCE_TYPES: readonly string[] = ["mission", "workflow_run", "issue", "transition_event", "pr", "heartbeat_run"];

const TITLE_MAX = 200;
const SUMMARY_MAX = 1200;
const TEXT_MAX = 2000;
const TAGS_MAX = 8;
const EVIDENCE_MAX = 10;

export type KnowledgePattern = typeof companyKnowledgePatterns.$inferSelect;

function readTrimmed(value: unknown, field: string, max: number, required: boolean): string | null {
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

function readEvidence(value: unknown): Array<Record<string, unknown>> {
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

function readTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > TAGS_MAX) {
    throw new Error(`knowledge pattern scopeTags must be an array of at most ${TAGS_MAX}`);
  }
  return value.map((tag) => String(tag).trim().toLowerCase().slice(0, 40)).filter((tag) => tag !== "");
}

export function knowledgePatternsService(db: Db) {
  return {
    /** append-only 생성. supersedeId가 있으면 같은 회사의 기존 카드를 대체 체인으로 연결한다. */
    create: async (input: {
      companyId: string;
      kind: unknown;
      title: unknown;
      summary: unknown;
      evidence?: unknown;
      symptoms?: unknown;
      rootCause?: unknown;
      whatWorked?: unknown;
      scopeTags?: unknown;
      source: unknown;
      createdByAgentId?: string | null;
      supersedeId?: string | null;
    }): Promise<KnowledgePattern> => {
      const kind = String(input.kind ?? "");
      if (!KINDS.includes(kind)) throw new Error(`knowledge pattern kind must be one of ${KINDS.join(", ")}`);
      const source = String(input.source ?? "");
      if (!SOURCES.includes(source)) throw new Error(`knowledge pattern source must be one of ${SOURCES.join(", ")}`);
      const title = readTrimmed(input.title, "title", TITLE_MAX, true)!;
      const summary = readTrimmed(input.summary, "summary", SUMMARY_MAX, true)!;
      const evidence = readEvidence(input.evidence);
      const symptoms = readTrimmed(input.symptoms, "symptoms", TEXT_MAX, false);
      const rootCause = readTrimmed(input.rootCause, "rootCause", TEXT_MAX, false);
      const whatWorked = readTrimmed(input.whatWorked, "whatWorked", TEXT_MAX, false);
      const scopeTags = readTags(input.scopeTags);

      if (input.supersedeId) {
        const [existing] = await db
          .select({ id: companyKnowledgePatterns.id, companyId: companyKnowledgePatterns.companyId, supersededById: companyKnowledgePatterns.supersededById })
          .from(companyKnowledgePatterns)
          .where(eq(companyKnowledgePatterns.id, input.supersedeId))
          .limit(1);
        if (!existing || existing.companyId !== input.companyId) {
          throw new Error("knowledge pattern supersede target must exist in the same company");
        }
        if (existing.supersededById) {
          throw new Error("knowledge pattern supersede target is already superseded");
        }
      }

      const [card] = await db
        .insert(companyKnowledgePatterns)
        .values({
          companyId: input.companyId,
          kind,
          title,
          summary,
          evidence,
          ...(symptoms ? { symptoms } : {}),
          ...(rootCause ? { rootCause } : {}),
          ...(whatWorked ? { whatWorked } : {}),
          scopeTags,
          source,
          createdByAgentId: input.createdByAgentId ?? null,
          supersededById: null,
        })
        .returning();

      if (input.supersedeId) {
        await db
          .update(companyKnowledgePatterns)
          .set({ supersededById: card.id })
          .where(and(eq(companyKnowledgePatterns.id, input.supersedeId), isNull(companyKnowledgePatterns.supersededById)));
      }

      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: input.createdByAgentId ?? "knowledge-patterns",
        action: "knowledge_pattern.created",
        entityType: "knowledge_pattern",
        entityId: card.id,
        details: { kind, title, source, supersededId: input.supersedeId ?? null },
      });
      return card;
    },

    /** 검색 — superseded 기본 제외. kind/tags/q(제목·요약·증상·근본원인 ILIKE) 필터. */
    search: async (input: {
      companyId: string;
      kind?: string | null;
      tags?: readonly string[] | null;
      q?: string | null;
      includeSuperseded?: boolean;
      limit?: number;
    }): Promise<KnowledgePattern[]> => {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
      const conditions = [eq(companyKnowledgePatterns.companyId, input.companyId)];
      if (!input.includeSuperseded) {
        conditions.push(isNull(companyKnowledgePatterns.supersededById));
      }
      if (input.kind && KINDS.includes(input.kind)) {
        conditions.push(eq(companyKnowledgePatterns.kind, input.kind));
      }
      const tags = readTags(input.tags);
      if (tags.length > 0) {
        conditions.push(sql`${companyKnowledgePatterns.scopeTags} && ARRAY[${sql.join(tags.map((tag) => sql`${tag}`), sql`, `)}]::text[]`);
      }
      const q = input.q?.trim();
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
      return db
        .select()
        .from(companyKnowledgePatterns)
        .where(and(...conditions))
        .orderBy(desc(companyKnowledgePatterns.createdAt))
        .limit(limit);
    },
  };
}
