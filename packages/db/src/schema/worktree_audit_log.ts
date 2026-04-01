import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { worktreeRules } from "./worktree_rules.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const worktreeAuditLog = pgTable(
  "worktree_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => worktreeRules.id, { onDelete: "set null" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    result: text("result").notNull(),
    contextHash: text("context_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdCreatedAtIdx: index("idx_worktree_audit_log_company_id_created_at").on(
      table.companyId,
      table.createdAt,
    ),
    agentIdIdx: index("idx_worktree_audit_log_agent_id").on(table.agentId),
    issueIdIdx: index("idx_worktree_audit_log_issue_id").on(table.issueId),
  }),
);
