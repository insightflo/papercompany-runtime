// server/src/services/knowledge-patterns.ts
//
// [파일 목적] 사고→패턴 지식 위키 서비스 — company_knowledge_patterns 테이블의
//   append-only 큐레이션 카드 생성/검색. 설계: artifacts doc/plans/2026-08-28-incident-pattern-knowledge-wiki.md
// [불변식]
//   - append-only: 내용(title/summary/evidence 등) 수정 API 없음. 대체는 supersedeId로 새 카드 발행
//     + 이전 카드 링크 갱신. 유일한 상태 전이는 approve(자동 초안 draft→active)뿐 — 내용 불변.
//   - 회사 스코프 필수(규칙 1). 검색/대체 대상은 같은 회사로 제한.
//   - 구조화 레코드만 권위(규칙 8) — evidence는 {type,id,note} 배열, 프로즈 파싱 없음.
//   - 생성 시 activity log 기록.
// [소비] 미션 오너 진단/기획 검색, 자기개선 근거 참조. draft 초안은 검색 기본 제외(승인 전 무측).
//   실행 프롬프트 주입은 별도 계약(관련도+게이트+측정 롤아웃 — knowledge-pattern-injection)으로만.

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledgePatterns, activityLog } from "@paperclipai/db";
import type { AdoptionAssetRegistryEntry } from "./self-improvement-adoption-planner.js";
import { selectRelatedKnowledgePatterns, type RelatedKnowledgePattern } from "./knowledge-pattern-relevance.js";

export type KnowledgePatternKind = "failure_mode" | "success_recipe" | "constraint";
export type KnowledgePatternSource = "mission_owner_compile" | "agent_candidate" | "operator" | "auto_rework_draft";
export const KNOWLEDGE_PATTERN_STATUS_DRAFT = "draft";
export const KNOWLEDGE_PATTERN_STATUS_ACTIVE = "active";

const KINDS: readonly string[] = ["failure_mode", "success_recipe", "constraint"];
const SOURCES: readonly string[] = ["mission_owner_compile", "agent_candidate", "operator", "auto_rework_draft"];
const EVIDENCE_TYPES: readonly string[] = ["mission", "workflow_run", "issue", "transition_event", "pr", "heartbeat_run"];

const TITLE_MAX = 200;
const SUMMARY_MAX = 1200;
const TEXT_MAX = 2000;
const TAGS_MAX = 8;
const EVIDENCE_MAX = 10;

export type KnowledgePattern = typeof companyKnowledgePatterns.$inferSelect;

// [Phase 2 — 자기개선 연결] 검색된 패턴 카드를 adoption planner의 assetRegistry
//   엔트리(knowledge_pattern 자산)로 변환한다. 호출자는 회사 스코프 검색 결과만
//   넘겨야 한다(규칙 1) — 플래너는 레지스트리 등재 여부로 참조 해석을 판정한다.
export function knowledgePatternAdoptionRegistryEntries(
  cards: Array<Pick<KnowledgePattern, "id">>,
): AdoptionAssetRegistryEntry[] {
  return cards.map((card) => ({ assetType: "knowledge_pattern", assetRef: card.id, resolvedRef: card.id }));
}

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
    /** [중복 힌트 — EvoHarness compaction 교훈] 새 카드와 유사한 기존 카드 상위 3건.
     *  supersede 대상 후보 제안용 비차단 힌트(superseded 제외 풀에서 스코프태그+토큰 중복). */
    findSimilar: async (input: {
      companyId: string;
      title: string;
      symptoms?: string | null;
      rootCause?: string | null;
      scopeTags?: readonly string[];
    }): Promise<RelatedKnowledgePattern[]> => {
      const cards = await knowledgePatternsService(db).search({ companyId: input.companyId, limit: 50 });
      return selectRelatedKnowledgePatterns(
        cards,
        [input.title, input.symptoms ?? "", input.rootCause ?? "", ...(input.scopeTags ?? [])],
      );
    },
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

    /** [P1 자동 초안 — 반복 QA 기계 교정] 동일 결함 서명 반복 감지 시 failure_mode 초안 카드 생성.
     *  append-only 유지: 초안은 새 insert이고 유일한 상태 전이는 approve(draft→active)뿐이다.
     *  (company_id, defect_signature) 부분 유일 인덱스로 중복 초안 방지 — 충돌 시 {card: null}.
     *  초안은 검색/주입 기본 제외(status='draft')라 승인 전까지 소비 면에서 무측. */
    createAutoReworkDraft: async (input: {
      companyId: string;
      signature: string;
      title: string;
      summary: string;
      symptoms?: string | null;
      whatWorked?: string | null;
      evidence?: Array<Record<string, unknown>>;
    }): Promise<{ card: KnowledgePattern | null }> => {
      const signature = input.signature.trim();
      if (!signature) throw new Error("knowledge pattern auto draft requires a defect signature");
      const title = readTrimmed(input.title, "title", TITLE_MAX, true)!;
      const summary = readTrimmed(input.summary, "summary", SUMMARY_MAX, true)!;
      const evidence = readEvidence(input.evidence);
      const symptoms = readTrimmed(input.symptoms, "symptoms", TEXT_MAX, false);
      const whatWorked = readTrimmed(input.whatWorked, "whatWorked", TEXT_MAX, false);

      const [card] = await db
        .insert(companyKnowledgePatterns)
        .values({
          companyId: input.companyId,
          kind: "failure_mode",
          title,
          summary,
          evidence,
          ...(symptoms ? { symptoms } : {}),
          whatWorked: whatWorked ?? null,
          scopeTags: ["qa-remediation"],
          source: "auto_rework_draft",
          defectSignature: signature,
          status: KNOWLEDGE_PATTERN_STATUS_DRAFT,
        })
        .onConflictDoNothing()
        .returning();

      if (!card) return { card: null };
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "knowledge-patterns",
        action: "knowledge_pattern.auto_draft",
        entityType: "knowledge_pattern",
        entityId: card.id,
        details: { kind: "failure_mode", title, source: "auto_rework_draft", defectSignature: signature },
      });
      return { card };
    },

    /** [P1 승인 + P2 주입 큐레이션] 자동 초안 draft→active 전이. 유일하게 허용된 status 변경이며
     *  카드 내용은 불변. audience는 사람이 승인 시에만 'agent'로 지정 가능(기본 'ops' 유지 =
     *  주입 없음). fail-closed — 주입은 명시적 사람 선택일 때만 열린다. */
    approve: async (input: {
      companyId: string;
      id: string;
      /** 승인과 동시에 주입 대상으로 큐레이션('agent'). 미지정 시 'ops'(주입 없음). */
      audience?: string | null;
    }): Promise<KnowledgePattern> => {
      const audience = input.audience == null || input.audience === "" ? null : String(input.audience);
      if (audience != null && audience !== "agent" && audience !== "ops") {
        throw new Error("knowledge pattern audience must be 'agent' or 'ops'");
      }
      const [updated] = await db
        .update(companyKnowledgePatterns)
        .set({
          status: KNOWLEDGE_PATTERN_STATUS_ACTIVE,
          ...(audience ? { audience } : {}),
        })
        .where(and(
          eq(companyKnowledgePatterns.id, input.id),
          eq(companyKnowledgePatterns.companyId, input.companyId),
          eq(companyKnowledgePatterns.status, KNOWLEDGE_PATTERN_STATUS_DRAFT),
        ))
        .returning();
      if (!updated) {
        throw new Error("knowledge pattern draft not found (already active or belongs to another company)");
      }
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "knowledge-patterns",
        action: "knowledge_pattern.approved",
        entityType: "knowledge_pattern",
        entityId: updated.id,
        details: { source: updated.source, defectSignature: updated.defectSignature, audience: updated.audience },
      });
      return updated;
    },

    /** [P2 주입 큐레이션] 사람(보드)이 카드의 audience를 지정한다 — 내용 불변, 주입 자격 플래그만 변경.
     *  draft/active 모두 가능(승인 전 주입 예약 포함). 기본 'ops' = 주입 없음(fail-closed). */
    curateAudience: async (input: { companyId: string; id: string; audience: string }): Promise<KnowledgePattern> => {
      if (input.audience !== "agent" && input.audience !== "ops") {
        throw new Error("knowledge pattern audience must be 'agent' or 'ops'");
      }
      const [updated] = await db
        .update(companyKnowledgePatterns)
        .set({ audience: input.audience })
        .where(and(eq(companyKnowledgePatterns.id, input.id), eq(companyKnowledgePatterns.companyId, input.companyId)))
        .returning();
      if (!updated) {
        throw new Error("knowledge pattern not found (belongs to another company)");
      }
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "knowledge-patterns",
        action: "knowledge_pattern.audience_curated",
        entityType: "knowledge_pattern",
        entityId: updated.id,
        details: { audience: updated.audience, status: updated.status },
      });
      return updated;
    },

    /** 검색 — superseded 기본 제외. kind/tags/q(제목·요약·증상·근본원인 ILIKE) 필터.
     *  draft 초안은 기본 제외(includeDrafts=true일 때만 노출 — 승인 화면 전용). */
    search: async (input: {
      companyId: string;
      kind?: string | null;
      tags?: readonly string[] | null;
      q?: string | null;
      includeSuperseded?: boolean;
      includeDrafts?: boolean;
      limit?: number;
    }): Promise<KnowledgePattern[]> => {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
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
