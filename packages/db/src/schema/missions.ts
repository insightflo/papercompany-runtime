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
  }),
);
