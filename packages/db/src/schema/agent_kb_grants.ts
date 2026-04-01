import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { knowledgeBases } from "./knowledge_bases.js";

export const agentKbGrants = pgTable(
  "agent_kb_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").notNull().references(() => knowledgeBases.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("idx_agent_kb_grants_agent_id").on(table.agentId),
    kbIdIdx: index("idx_agent_kb_grants_kb_id").on(table.kbId),
    uniqueIdx: uniqueIndex("agent_kb_grants_agent_id_kb_id_key").on(table.agentId, table.kbId),
  }),
);
