import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const worktreeRules = pgTable(
  "worktree_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    severity: text("severity").notNull(),
    action: text("action").notNull(),
    predicate: jsonb("predicate").$type<Record<string, unknown>>().notNull().default({}),
    decisionMap: jsonb("decision_map").$type<Record<string, unknown>>().notNull().default({}),
    message: text("message").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_worktree_rules_company_id").on(table.companyId),
  }),
);
