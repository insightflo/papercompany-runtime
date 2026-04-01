import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { missions } from "./missions.js";
import { sql } from "drizzle-orm";

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_schedules_company_id").on(table.companyId),
    agentIdIdx: index("idx_schedules_agent_id").on(table.agentId),
    nextRunAtIdx: index("idx_schedules_next_run_at").on(table.nextRunAt),
    companyIdNextRunAtIdx: index("idx_schedules_company_id_next_run_at").on(
      table.companyId,
      table.nextRunAt,
    ),
  }),
);
