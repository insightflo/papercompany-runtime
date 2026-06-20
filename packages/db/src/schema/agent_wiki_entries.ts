import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { missions } from "./missions.js";

// [파일 목적] Agent self-learning wiki — 반복되는 실행 실패 패턴을 (company, agent) 단위로
//   축적하고, 다음 adapter run에 주입해 같은 실수가 반복되지 않도록 돕는 실패 지식 베이스.
//   heartbeat가 실패를 감지해 기록(recordFailure)하고, adapter 실행 전 가장 빈번한 활성
//   교훈을 검색(searchRelevant)해 prompt에 주입한다.
// [주요 흐름] recordFailure(onConflict dedup → frequency++) → searchRelevant(frequency desc)
//   → markResolved/close(Phase 3 자가진화).
// [외부 연결] FK: companies(cascade) / agents(cascade) / missions(set null).
//   service: server/src/services/agent-wiki.ts. consumer: heartbeat.ts.
// [수정시 주의] recordFailure()의 onConflict target이 아래 dedup unique index와 정확히
//   일치해야 dedup가 동작한다. 컬럼/인덱스 변경 시 service의 onConflict target과
//   마이그레이션(0061)을 함께 갱신할 것. agent_id는 NOT NULL이다 — 모든 실패에는 구체적
//   agent가 있고, ON CONFLICT 추론이 non-null agent_id를 필요로 한다(NULL은 distinct).
export const agentWikiEntries = pgTable(
  "agent_wiki_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    pattern: text("pattern").notNull(),
    cause: text("cause").notNull(),
    solution: text("solution").notNull(),
    errorCode: text("error_code"),
    stepId: text("step_id"),
    frequency: integer("frequency").notNull().default(1),
    status: text("status").notNull().default("active"), // active | resolved | closed
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // dedup arbiter — recordFailure()의 onConflictDoUpdate target과 1:1 일치해야 한다.
    // error_code는 nullable이며, Postgres unique index에서 NULL은 distinct 취급된다.
    // 모든 검출 지점이 non-null errorCode를 전달하므로 실사용에서 dedup가 보장된다.
    dedupUniqueIdx: uniqueIndex("agent_wiki_entries_company_agent_pattern_code_key").on(
      table.companyId,
      table.agentId,
      table.pattern,
      table.errorCode,
    ),
    companyAgentStatusIdx: index("agent_wiki_entries_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyPatternIdx: index("agent_wiki_entries_company_pattern_idx").on(
      table.companyId,
      table.pattern,
    ),
  }),
);
