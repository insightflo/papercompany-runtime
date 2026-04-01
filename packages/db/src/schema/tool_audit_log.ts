import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { toolDefinitions } from "./tool_definitions.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const toolAuditLog = pgTable(
  "tool_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolId: uuid("tool_id").notNull().references(() => toolDefinitions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    argsHash: text("args_hash").notNull(),
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toolIdIdx: index("idx_tool_audit_log_tool_id").on(table.toolId),
    companyIdIdx: index("idx_tool_audit_log_company_id").on(table.companyId),
    agentIdIdx: index("idx_tool_audit_log_agent_id").on(table.agentId),
  }),
);
