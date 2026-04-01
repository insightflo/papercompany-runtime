import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { worktreeRules } from "./worktree_rules.js";
import { sql } from "drizzle-orm";

export const worktreeRuleProposals = pgTable(
  "worktree_rule_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => worktreeRules.id, { onDelete: "set null" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    proposedBy: text("proposed_by").notNull(),
    proposedChange: jsonb("proposed_change").$type<Record<string, unknown>>().notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").notNull().default("proposed"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ruleIdIdx: index("idx_worktree_rule_proposals_rule_id").on(table.ruleId),
    companyIdIdx: index("idx_worktree_rule_proposals_company_id").on(table.companyId),
    statusIdx: index("idx_worktree_rule_proposals_status").on(table.status),
  }),
);
