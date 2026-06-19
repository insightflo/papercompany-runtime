// server/src/services/agent-wiki.ts
//
// [파일 목적] Agent self-learning wiki service — 반복 실패 패턴을 (company, agent) 단위로
//   축적(recordFailure, onConflict dedup → frequency++)하고, adapter 실행 전 가장 빈번한
//   활성 교훈을 검색(searchRelevant)해 prompt에 주입한다. 단일 테이블 agent_wiki_entries CRUD.
// [주요 흐름]
//   1) heartbeat 실패 감지 → recordFailure(dedup 증가 또는 신규 삽입)
//   2) adapter 실행 전 → searchRelevant(frequency desc) → formatWikiLessons → prompt 주입
//   3) Phase 3: 반복 패턴 해소 → markResolved / close
// [외부 연결] consumer: heartbeat.ts(Phase 1 감지 훅 + Phase 2 주입). db는 caller가 주입.
// [수정시 주의]
//   - recordFailure의 onConflictDoUpdate target은 unique index
//     agent_wiki_entries_company_agent_pattern_code_key 와 정확히 일치해야 dedup가 동작.
//   - 서비스는 에러를 throw(로그 후 rethrow)한다. main flow를 깨뜨리지 않으려면
//     caller가 try/catch로 감싸 non-blocking 처리할 것(heartbeat 훅 참조).

import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWikiEntries, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type AgentWikiEntry = typeof agentWikiEntries.$inferSelect;

export interface RecordFailureInput {
  companyId: string;
  agentId: string;
  missionId?: string | null;
  pattern: string;
  cause: string;
  solution: string;
  errorCode?: string | null;
  stepId?: string | null;
}

export interface SearchRelevantInput {
  companyId: string;
  agentId: string;
  /** 좁히기용 step 식별자. 없으면 agent 전체에서 frequency desc. */
  stepId?: string | null;
  limit?: number;
}

/**
 * [목적] recordFailure — 실패 wiki entry upsert.
 *   동일 (company, agent, pattern, error_code) 활성 entry가 있으면 frequency++ 및 최근
 *   발생 메타데이터 갱신; 없으면 frequency=1 신규 삽입. 이전 resolved/closed는 재발로
 *   무효화되어 다시 active로 되돌아간다(다음 주입 대상).
 * [입력] cause/solution 필수. errorCode는 dedup key의 일부(null은 별도 버킷이나,
 *   모든 heartbeat 검출 지점은 non-null errorCode를 전달한다).
 * [출력] upsert된 row.
 * [연결] heartbeat.ts 실패 감지 지점 5곳에서 호출.
 * [주의] 에러 발생 시 로그 후 rethrow. caller는 non-blocking을 위해 try/catch 감싸야 함.
 * [수정시 영향] onConflict target 변경 시 0061 migration의 unique index와 schema/index.ts,
 *   그리고 drizzle schema의 dedupUniqueIdx를 함께 변경해야 dedup가 유지된다.
 */
export async function recordFailure(db: Db, input: RecordFailureInput): Promise<AgentWikiEntry> {
  const now = new Date();
  try {
    const [row] = await db
      .insert(agentWikiEntries)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        missionId: input.missionId ?? null,
        pattern: input.pattern,
        cause: input.cause,
        solution: input.solution,
        errorCode: input.errorCode ?? null,
        stepId: input.stepId ?? null,
        status: "active",
        frequency: 1,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          agentWikiEntries.companyId,
          agentWikiEntries.agentId,
          agentWikiEntries.pattern,
          agentWikiEntries.errorCode,
        ],
        set: {
          frequency: sql`${agentWikiEntries.frequency} + 1`,
          lastSeenAt: now,
          // 최근 발생 컨텍스트로 덮어쓰기(첫 발생 정보는 createdAt/frequency로 보존됨).
          missionId: input.missionId ?? null,
          stepId: input.stepId ?? null,
          cause: input.cause,
          solution: input.solution,
          // 재발 → 이전 해결(resolved)/종료(closed) 상태 무효화, 다시 활성 교훈으로.
          status: "active",
          resolvedAt: null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  } catch (error) {
    logger.error(
      { err: error, companyId: input.companyId, agentId: input.agentId, pattern: input.pattern },
      "agent-wiki.recordFailure failed",
    );
    throw error;
  }
}

/**
 * [목적] formatWikiLessons — searchRelevant 결과를 adapter prompt에 주입할 한국어 섹션으로 변환.
 *   빈 배열이면 null 반환(주입 생략 — 빈 교훈 블록이 prompt를 오염시키지 않도록).
 * [출력] "## 과거 실패 교훈 (자동 생성 ...)" 섹션 문자열, 또는 null.
 */
export function formatWikiLessons(entries: AgentWikiEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((entry) => `- [${entry.frequency}회 누적] ${entry.pattern}: ${entry.solution}`);
  return `## 과거 실패 교훈 (자동 생성 — 같은 실수 방지)\n${lines.join("\n")}`;
}

export function agentWikiService(db: Db) {
  return {
    recordFailure: (input: RecordFailureInput) => recordFailure(db, input),

    /**
     * [목적] searchRelevant — 해당 agent의 가장 빈번한 활성 실패 교훈 반환.
     * [출력] status='active' entry, frequency desc → lastSeenAt desc, limit(기본 5).
     * [연결] Phase 2: heartbeat.ts adapter 실행 전 prompt 주입에 사용.
     */
    searchRelevant: async (input: SearchRelevantInput): Promise<AgentWikiEntry[]> => {
      const limit = input.limit ?? 5;
      const conditions = [
        eq(agentWikiEntries.companyId, input.companyId),
        eq(agentWikiEntries.agentId, input.agentId),
        eq(agentWikiEntries.status, "active"),
      ];
      if (input.stepId) {
        conditions.push(eq(agentWikiEntries.stepId, input.stepId));
      }
      return db
        .select()
        .from(agentWikiEntries)
        .where(and(...conditions))
        .orderBy(desc(agentWikiEntries.frequency), desc(agentWikiEntries.lastSeenAt))
        .limit(limit);
    },

    getById: (id: string) =>
      db
        .select()
        .from(agentWikiEntries)
        .where(eq(agentWikiEntries.id, id))
        .then((rows) => (rows[0] ?? null)),

    /**
     * [목적] markResolved — 반복 실패가 해결됨(Phase 3 validation 통과 시). status='resolved'.
     *   여전히 검색 가능하나 searchRelevant(active 필터)에서는 제외. 재발 시 recordFailure가
     *   다시 'active'로 되돌린다.
     */
    markResolved: (id: string) =>
      db
        .update(agentWikiEntries)
        .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWikiEntries.id, id))
        .returning()
        .then((rows) => (rows[0] ?? null)),

    /** [목적] close — 종단 상태. 더 이상 주입/검색 대상 아님. */
    close: (id: string) =>
      db
        .update(agentWikiEntries)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(agentWikiEntries.id, id))
        .returning()
        .then((rows) => (rows[0] ?? null)),

    list: (companyId: string) =>
      db
        .select()
        .from(agentWikiEntries)
        .where(eq(agentWikiEntries.companyId, companyId))
        .orderBy(desc(agentWikiEntries.updatedAt)),

    /**
     * [목적] timeseries — 최근 N일간 실패 heartbeat_run을 일자(KST)×errorCode로 집계.
     *   wiki entry 축적의 원천(실패 발생) 추이를 보여, 교훈 주입이 같은 실수 감소로
     *   이어지는지(추세 하락) 확인하는 시계열 근거로 쓰인다.
     * [입력] companyId, days(기본 14).
     * [출력] { day(YYYY-MM-DD KST), errorCode(null=미분류 실패 포함), count }[].
     * [수정시 영향] 집계 단위/필터(status, error_code)를 바꾸면 UI 시계열 범례도 함께 조정.
     */
    timeseries: async (
      companyId: string,
      days = 14,
    ): Promise<{ day: string; errorCode: string | null; count: number }[]> => {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const dayExpr = sql<string>`to_char(${heartbeatRuns.finishedAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
      return db
        .select({
          day: dayExpr,
          errorCode: heartbeatRuns.errorCode,
          count: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.finishedAt, since),
            ne(heartbeatRuns.status, "succeeded"),
          ),
        )
        .groupBy(dayExpr, heartbeatRuns.errorCode)
        .orderBy(dayExpr);
    },
  };
}
