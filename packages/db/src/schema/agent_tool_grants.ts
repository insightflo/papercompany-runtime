import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { toolDefinitions } from "./tool_definitions.js";

export const agentToolGrants = pgTable(
  "agent_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id").notNull().references(() => toolDefinitions.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("idx_agent_tool_grants_company_id").on(table.companyId),
    agentIdIdx: index("idx_agent_tool_grants_agent_id").on(table.agentId),
    toolIdIdx: index("idx_agent_tool_grants_tool_id").on(table.toolId),
    uniqueIdx: uniqueIndex("agent_tool_grants_company_agent_tool_key").on(table.companyId, table.agentId, table.toolId),
  }),
);
