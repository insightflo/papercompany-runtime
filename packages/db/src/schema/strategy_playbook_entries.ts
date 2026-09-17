import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * 전략 플레이북 항목 (쇼츠 컴퍼니 Phase F).
 *
 * 한 행 = "이런 조건(trigger)이 오면 이런 행동(action)을 한다"는 전략 규칙 제안.
 * 에이전트는 status='proposed' 행만 만들 수 있고, 활성화(active)/은퇴(retired) 전이는
 * 보드(운영자) 승인 전용이다. 조건 자동 적용 실행기는 별도 구현이며 이 테이블은
 * 저장/승인 수명주기만 담당한다.
 *
 * - channel/triggerType/actionType/status 는 enum 컬럼이 아니라 text + 애플리케이션
 *   검증(shared zod)으로 관리한다.
 * - conditionJson/actionJson 은 객체여야 한다(구조는 자유).
 * - evidenceRefs 는 근거 참조 문자열 배열(기본 '[]').
 */
export const strategyPlaybookEntries = pgTable(
  "strategy_playbook_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    triggerType: text("trigger_type").notNull(),
    conditionJson: jsonb("condition_json").$type<Record<string, unknown>>().notNull(),
    actionType: text("action_type").notNull(),
    actionJson: jsonb("action_json").$type<Record<string, unknown>>().notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("proposed"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_strategy_playbook_entries_company_id").on(table.companyId),
    statusIdx: index("idx_strategy_playbook_entries_status").on(table.status),
  }),
);
