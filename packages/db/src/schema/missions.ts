import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { goals } from "./goals.js";
import { projects } from "./projects.js";

export const missions = pgTable(
  "missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("planning"),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    // [목적] mission ↔ project 1-hop 직접 연결. goalId↔project_goals 파생 경로의 손실/모호함을
    // 피하기 위해 project 연결의 권위(authoritative) 컬럼으로 쓴다. goalId는 보조로 유지.
    // [외부 연결] create UI project 선택, missions 리스트/상세 project 표시가 이 컬럼을 读는다.
    // [수정시 영향] project 미연결 mission/agent 런의 workspace 주입(Phase2)이 이 값 유무로 분기한다.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_missions_company_id").on(table.companyId),
    ownerAgentIdIdx: index("idx_missions_owner_agent_id").on(table.ownerAgentId),
    statusIdx: index("idx_missions_status").on(table.status),
    goalIdIdx: index("idx_missions_goal_id").on(table.goalId),
    projectIdIdx: index("idx_missions_project_id").on(table.projectId),
  }),
);
