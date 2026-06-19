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
import { agentWikiEntries } from "./agent_wiki_entries.js";

// [파일 목적] Agent Wiki Phase 3 — SkillOpt-Sleep 자가진화 추적 테이블. 반복 실패(frequency≥threshold)
//   를 agent 의 영구 promptTemplate 에 bounded-edit 로 넣는 "제안(proposal)" 의 수명주기를 관리한다.
// [주요 흐름] proposing(에디트 적용+관찰) → accepted(유지, entry=resolved) | rejected(revert).
//   재발 시 기각된 제안은 baseline 갱신 후 다시 proposing 으로 upsert 될 수 있다.
// [외부 연결] FK: agent_wiki_entries(cascade) / agents(cascade) / companies(cascade).
//   consumer: server/src/services/agent-skill-optimizer.ts (runWikiEvolutionPass).
// [수정시 주의] entry_id unique index 덕분에 entry 당 제안은 1개. agent-skill-optimizer 의
//   upsertProposal onConflict target 과 1:1 로 맞아야 한다.
export const agentWikiEditProposals = pgTable(
  "agent_wiki_edit_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id").notNull().references(() => agentWikiEntries.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    // proposing(에디트 적용 + 관찰 중) | accepted(유지, 학습 완료) | rejected(revert 됨)
    status: text("status").notNull().default("proposing"),
    baselineFrequency: integer("baseline_frequency").notNull(),
    // 제안 시점 원본 promptTemplate 스냅샷(revert 참고용). v1 에는 bounded-edit marker strip 으로 revert.
    originalSnapshot: text("original_snapshot"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // entry 당 제안 1개 — upsertProposal 의 onConflict target.
    entryUniqueIdx: uniqueIndex("agent_wiki_edit_proposals_entry_id_key").on(table.entryId),
    agentStatusIdx: index("agent_wiki_edit_proposals_agent_status_idx").on(table.agentId, table.status),
    proposingIdx: index("agent_wiki_edit_proposals_status_proposed_idx").on(table.status, table.proposedAt),
  }),
);
